// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { App, Stack, StackProps, RemovalPolicy, CfnOutput, CfnCapabilities, SecretValue } from 'aws-cdk-lib';

import { ApplicationStack } from '../lib/application-stack';

export interface PipelineStackProps extends StackProps {
  readonly uatApplicationStack: ApplicationStack;
  readonly uatAccountId: string;
  readonly githubOwner: string;
  readonly githubRepo: string;
  readonly githubBranch: string;
}

export class PipelineStack extends Stack {

  constructor(app: App, id: string, props: PipelineStackProps) {

    super(app, id, props);

    // Resolve ARNs of cross-account roles for the UAT account
    const uatCloudFormationRole = iam.Role.fromRoleArn(this, 
      'UatDeploymentRole', 
      `arn:aws:iam::${props.uatAccountId}:role/CloudFormationDeploymentRole`, {
        mutable: false
    });
    const uatCodePipelineRole = iam.Role.fromRoleArn(this, 
      'UatCrossAccountRole', 
      `arn:aws:iam::${props.uatAccountId}:role/CodePipelineCrossAccountRole`, {
        mutable: false
    });

    // Resolve root Principal ARNs for both deployment accounts
    const uatAccountRootPrincipal = new iam.AccountPrincipal(props.uatAccountId);

    // Create KMS key and update policy with cross-account access
    // CDKでは、aliasプロパティを指定することで、KMSキーとエイリアスを簡単に定義できます。
    // CDK内部では、AWS::KMS::Aliasリソースを作成してエイリアスを設定します。
    // cloudformationだと、KMSキーを定義し、その後にエイリアスを別途定義します。
    // CDKが完全管理権限を手動で設定する必要がない場合が多いです
    // cloudformationだと、管理権限の設定が必要　Allow "arn:aws:iam::${AWS::AccountId}:root" kms:*
    // 設定しないと、The new key policy will not allow you to update the key policy in the future.
    const key = new kms.Key(this, 'ArtifactKey', {
      alias: 'key/pipeline-artifact-key',
    });
    key.grantDecrypt(uatAccountRootPrincipal);
    key.grantDecrypt(uatCodePipelineRole);

    // Create S3 bucket with target account cross-account access
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `artifact-bucket-${this.account}`,
      removalPolicy: RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key
    });
    artifactBucket.grantPut(uatAccountRootPrincipal);
    artifactBucket.grantRead(uatAccountRootPrincipal);

    // CDK build definition
    const cdkBuild = new codebuild.PipelineProject(this, 'CdkBuild', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'npm install'
            ],
          },
          build: {
            commands: [
              'npm run build',
              'npm run cdk synth -- -o dist',
            ],
          },
        },
        artifacts: {
          'base-directory': 'dist',
          files: [
            '*ApplicationStack.template.json',
          ],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
      },
      // use the encryption key for build artifacts
      encryptionKey: key
    });

    // Lambda build definition
    // erviceRoleを明示的に指定する必要はありません。CDKは、必要なIAMロールを自動的に生成し、適切な権限を付与します。
    // CloudFormationだと、明示的に指定が必要
    const lambdaBuild = new codebuild.PipelineProject(this, 'LambdaBuild', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'cd app',
              'npm install',
            ],
          },
          build: {
            commands: 'npm run build',
          },
        },
        artifacts: {
          'base-directory': 'app',
          files: [
            'index.js',
            'node_modules/**/*',
          ],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
      },
      // use the encryption key for build artifacts
      encryptionKey: key
    });

    // Define pipeline stage output artifacts
    const sourceOutput = new codepipeline.Artifact();
    const cdkBuildOutput = new codepipeline.Artifact('CdkBuildOutput');
    const lambdaBuildOutput = new codepipeline.Artifact('LambdaBuildOutput');

    // GitHub トークン (Secrets Manager から取得することを推奨)
    const githubToken = SecretValue.secretsManager('GitHubToken'); 

    // Pipeline definition
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'CrossAccountPipeline',
      artifactBucket: artifactBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.GitHubSourceAction({
              actionName: 'GitHub_Source',
              owner: props.githubOwner, // GitHubユーザー名または組織名
              repo: props.githubRepo, // リポジトリ名
              branch: props.githubBranch, // 対象ブランチ
              oauthToken: githubToken, // GitHub トークン
              output: sourceOutput, // アーティファクトの出力
              trigger: codepipeline_actions.GitHubTrigger.POLL
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Application_Build',
              project: lambdaBuild,
              input: sourceOutput,
              outputs: [lambdaBuildOutput],
            }),
            new codepipeline_actions.CodeBuildAction({
              actionName: 'CDK_Synth',
              project: cdkBuild,
              input: sourceOutput,
              outputs: [cdkBuildOutput],
            }),
          ],
        },
        {
          stageName: 'Deploy_Uat',
          actions: [
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'Deploy',
              // pipeline.tsでconst uatApplicationStack = new ApplicationStack(app, 'UatApplicationStack', { stageName: 'uat' });
              // cdk synth実行時にUatApplicationStack.template.jsonが生成される
              templatePath: cdkBuildOutput.atPath('UatApplicationStack.template.json'),
              stackName: 'UatApplicationDeploymentStack',
              adminPermissions: false,
              // ApplicationStackのlambdaCode parameterを設定
              // CodePipelineが生成したindex.jsやnode_modulesといった成果物をZIP化し、Lambdaに渡します。
              // CDKの仕組みがバックエンドで成果物のZIP化やS3アップロードを管理しているため、ユーザーは明示的にZIP化を意識する必要がありません。
              parameterOverrides: {
                ...props.uatApplicationStack.lambdaCode.assign(
                    lambdaBuildOutput.s3Location),
              },
              extraInputs: [lambdaBuildOutput],
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
              role: uatCodePipelineRole,
              deploymentRole: uatCloudFormationRole,
            })
          ],
        }
      ]
    });

    // Add the target accounts to the pipeline policy
    pipeline.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [
        `arn:aws:iam::${props.uatAccountId}:role/*`,
      ]
    }));

    // Publish the KMS Key ARN as an output
    new CfnOutput(this, 'ArtifactBucketEncryptionKeyArn', {
      value: key.keyArn,
      exportName: 'ArtifactBucketEncryptionKey'
    });

  }
}
