#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AuctionDBStack } from '../lib/auction-db-stack';
import { AuthStack } from '../lib/auction-auth-stack';
import { AuctionApiStack } from '../lib/auction-api-stack';

const app = new cdk.App();

// 1. Deploy DB + S3
const backendStack = new AuctionDBStack(app, 'AuctionDBStack');

// 2. Deploy Cognito
const authStack = new AuthStack(app, 'AuthStack');

// 3. Deploy API (Lambdas + API Gateway) with references
new AuctionApiStack(app, 'AuctionApiStack', {
  auctionsTable: backendStack.auctionsTable,
  itemsTable: backendStack.itemsTable,
  imagesTable: backendStack.imagesTable,
  imagesBucket: backendStack.imagesBucket,
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  counterTable: backendStack.counterTable
});
