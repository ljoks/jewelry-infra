#!/usr/bin/env node
import 'dotenv/config';
import * as cdk from 'aws-cdk-lib';
import { AuctionDBStack } from '../lib/auction-db-stack';
import { AuthStack } from '../lib/auction-auth-stack';
import { AuctionApiStack } from '../lib/auction-api-stack';

const app = new cdk.App();

// Get account and region from environment (loaded from .env via dotenv)
const account = process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID;
const region = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

const env = account ? { account, region } : undefined;

// 1. Deploy DB + S3
const backendStack = new AuctionDBStack(app, 'AuctionDBStack', { env });

// 2. Deploy Cognito
const authStack = new AuthStack(app, 'AuthStack', {
  usersTable: backendStack.usersTable,
  env
});

// 3. Deploy API (Lambdas + API Gateway) with references
new AuctionApiStack(app, 'AuctionApiStack', {
  auctionsTable: backendStack.auctionsTable,
  itemsTable: backendStack.itemsTable,
  imagesTable: backendStack.imagesTable,
  imagesBucket: backendStack.imagesBucket,
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  counterTable: backendStack.counterTable,
  usersTable: backendStack.usersTable,
  metadataOptionsTable: backendStack.metadataOptionsTable,
  env
});
