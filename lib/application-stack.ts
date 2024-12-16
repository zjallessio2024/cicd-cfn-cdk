// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { StackProps, App, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';

export interface ApplicationStackProps extends StackProps {
  readonly stageName: string;
}

export class ApplicationStack extends Stack {
  public readonly lambdaCode: lambda.CfnParametersCode;

  constructor(app: App, id: string, props: ApplicationStackProps) {
    super(app, id, props);
    // CloudFormation パラメータが生成されます。
    // BucketName ObjectKey
    this.lambdaCode = lambda.Code.fromCfnParameters();

    const func = new lambda.Function(this, 'Lambda', {
      functionName: 'HelloLambda',
      // CDKが抽象化されたAPIを提供している
      // cloudformationだと、S3BucketとS3Keyで別々指定が必要
      code: this.lambdaCode,
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      environment: {
        STAGE_NAME: props.stageName
      }
    });

    new apigateway.LambdaRestApi(this, 'HelloLambdaRestApi', {
      // API Gateway がリクエストを転送する Lambda 関数
      handler: func,
      // API のエンドポイント名をエクスポート
      endpointExportName: 'HelloLambdaRestApiEndpoint',
      deployOptions: {
        stageName: props.stageName
      }
    });

    const version = func.currentVersion;
    // aliasName にステージ名（stageName）を指定し、バージョンを紐付ける
    const alias = new lambda.Alias(this, 'LambdaAlias', {
      aliasName: props.stageName,
      version,
    });

    new codedeploy.LambdaDeploymentGroup(this, 'DeploymentGroup', {
      alias,
      deploymentConfig: codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE,
    });

  }
}