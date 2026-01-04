# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk synth`   emits the synthesized CloudFormation template
* `npx cdk diff`    compare deployed stack with current state

## Deployment

### Prerequisites
1. Ensure AWS CLI is configured with your credentials:
   ```bash
   aws configure
   ```
2. Bootstrap CDK (only needed once per account/region):
   ```bash
   npx cdk bootstrap
   ```

### Deploy all stacks
Deploy all stacks in the correct order:
```bash
npx cdk deploy --all
```

### Deploy individual stacks
If deploying for the first time or in order:
1. **Deploy Database & S3** (must be first):
   ```bash
   npx cdk deploy AuctionDBStack
   ```

2. **Deploy Authentication** (depends on DB):
   ```bash
   npx cdk deploy AuthStack
   ```

3. **Deploy API** (depends on DB and Auth):
   ```bash
   npx cdk deploy AuctionApiStack
   ```

### Other useful commands
* `npx cdk diff` - Preview changes before deploying
* `npx cdk destroy` - Remove all stacks (use with caution!)
* `npx cdk list` - List all stacks in the app
