#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import { ApplicationStack } from '../lib/application-stack';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();
const uatAccountId = app.node.tryGetContext('uat-account') || process.env.CDK_INTEG_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT;
const githubOwner = app.node.tryGetContext('github-owner');
const githubRepo = app.node.tryGetContext('github-repo');
const githubBranch = app.node.tryGetContext('github-branch');


const uatApplicationStack = new ApplicationStack(app, 'UatApplicationStack', { stageName: 'uat' });
new PipelineStack(app, 'CrossAccountPipelineStack', {
  uatApplicationStack: uatApplicationStack,
  uatAccountId: uatAccountId,
  githubOwner: githubOwner,
  githubRepo: githubRepo,
  githubBranch: githubBranch
});
