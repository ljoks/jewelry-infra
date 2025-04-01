import { Stack, StackProps, Duration, SecretValue } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { HttpApi, HttpMethod, CorsHttpMethod } from '@aws-cdk/aws-apigatewayv2-alpha';
import { HttpLambdaIntegration } from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
import { HttpUserPoolAuthorizer, HttpUserPoolAuthorizerProps } from '@aws-cdk/aws-apigatewayv2-authorizers-alpha';
import { HttpLambdaAuthorizer } from '@aws-cdk/aws-apigatewayv2-authorizers-alpha';

import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket } from 'aws-cdk-lib/aws-s3';

import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, LayerVersion, Code, Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import { IUserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';

import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

interface AuctionApiStackProps extends StackProps {
  auctionsTable: Table;
  itemsTable: Table;
  imagesTable: Table;
  imagesBucket: Bucket;
  userPool: IUserPool; // from AuthStack
  userPoolClient: UserPoolClient;
  counterTable: Table;
  usersTable: Table;
}

export class AuctionApiStack extends Stack {
  public readonly httpApi: HttpApi;

  constructor(scope: Construct, id: string, props: AuctionApiStackProps) {
    super(scope, id, props);

    // 1. Create Lambdas
    // Auctions Lambda
    const auctionsLambda = new NodejsFunction(this, 'AuctionsLambda', {
      entry: path.join(__dirname, '..', 'src', 'handlers', 'auctions.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_LATEST,
      environment: {
        AUCTIONS_TABLE: props.auctionsTable.tableName,
        ITEMS_TABLE: props.itemsTable.tableName,
        IMAGES_TABLE: props.imagesTable.tableName,
        BUCKET_NAME: props.imagesBucket.bucketName
      },
    });
    props.auctionsTable.grantReadWriteData(auctionsLambda);
    props.imagesBucket.grantRead(auctionsLambda);
    props.itemsTable.grantReadWriteData(auctionsLambda);
    props.imagesTable.grantReadData(auctionsLambda);

    // Items Lambda
    const itemsLambda = new NodejsFunction(this, 'ItemsLambda', {
      entry: path.join(__dirname, '..', 'src', 'handlers', 'items.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_LATEST,
      environment: {
        ITEMS_TABLE: props.itemsTable.tableName,
        AUCTIONS_TABLE: props.auctionsTable.tableName,
        IMAGES_TABLE: props.imagesTable.tableName,
        COUNTER_TABLE: props.counterTable.tableName
      },
    });
    props.itemsTable.grantReadWriteData(itemsLambda);
    props.auctionsTable.grantReadData(itemsLambda);
    props.imagesTable.grantReadData(itemsLambda);
    props.counterTable.grantReadWriteData(itemsLambda);

    // Images Lambda
    const imagesLambda = new NodejsFunction(this, 'ImagesLambda', {
      entry: path.join(__dirname, '..', 'src', 'handlers', 'images.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_LATEST,
      environment: {
        IMAGES_TABLE: props.imagesTable.tableName,
        ITEMS_TABLE: props.itemsTable.tableName,
        BUCKET_NAME: props.imagesBucket.bucketName,
      },
    });
    props.imagesTable.grantReadWriteData(imagesLambda);
    props.itemsTable.grantReadData(imagesLambda);
    props.imagesBucket.grantReadWrite(imagesLambda);

    // Import or look up your existing secret
    const openAiSecret = Secret.fromSecretNameV2(this, 'OPENAI_API_KEY', 'OPENAI_API_KEY');

    // Combined process items lambda (replaces both group_images and finalize_items)
    const processItemsLambda = new NodejsFunction(this, 'ProcessItemsLambda', {
      entry: path.join(__dirname, '..', 'src', 'handlers', 'process-items.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_LATEST,
      environment: {
        BUCKET_NAME: props.imagesBucket.bucketName,
        ITEMS_TABLE: props.itemsTable.tableName,
        IMAGES_TABLE: props.imagesTable.tableName,
        COUNTER_TABLE: props.counterTable.tableName,
        OPENAI_SECRET_ARN: openAiSecret.secretArn,
      },
      timeout: Duration.seconds(30)
    });
    props.imagesBucket.grantReadWrite(processItemsLambda);
    props.itemsTable.grantReadWriteData(processItemsLambda);
    props.imagesTable.grantReadWriteData(processItemsLambda);
    props.counterTable.grantReadWriteData(processItemsLambda);
    openAiSecret.grantRead(processItemsLambda);

    // Export Catalog Lambda
    const exportCatalogLambda = new LambdaFunction(this, 'ExportCatalogLambda', {
      runtime: Runtime.PYTHON_3_9,
      code: Code.fromAsset('src/python_handlers'),
      handler: 'export_catalog.lambda_handler',
      environment: {
        BUCKET_NAME: props.imagesBucket.bucketName,
        ITEMS_TABLE: props.itemsTable.tableName,
        IMAGES_TABLE: props.imagesTable.tableName,
      },
      timeout: Duration.seconds(30)
    });
    props.imagesBucket.grantReadWrite(exportCatalogLambda);
    props.itemsTable.grantReadData(exportCatalogLambda);
    props.imagesTable.grantReadData(exportCatalogLambda);

    // Create the admin authorizer Lambda
    const adminAuthorizerLambda = new NodejsFunction(this, 'AdminAuthorizerLambda', {
      entry: path.join(__dirname, '..', 'src', 'authorizers', 'admin-authorizer.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_LATEST,
      environment: {
        USERS_TABLE: props.usersTable.tableName,
      },
    });
    props.usersTable.grantReadData(adminAuthorizerLambda);

    // Create the admin authorizer
    const adminAuthorizer = new HttpLambdaAuthorizer('AdminAuthorizer', adminAuthorizerLambda);

    // Create the check-admin Lambda
    const checkAdminLambda = new NodejsFunction(this, 'CheckAdminLambda', {
      entry: path.join(__dirname, '..', 'src', 'handlers', 'check-admin.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_LATEST,
      environment: {
        USERS_TABLE: props.usersTable.tableName,
      },
    });
    props.usersTable.grantReadData(checkAdminLambda);

    // Create the check-admin integration
    const checkAdminIntegration = new HttpLambdaIntegration("CheckAdminIntegration", checkAdminLambda);

    // 2. Create the HTTP API
    this.httpApi = new HttpApi(this, 'AuctionServiceApi', {
      apiName: 'AuctionServiceApi',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PUT, CorsHttpMethod.DELETE],
        allowOrigins: ['*'], // refine in production
      },
    });

    // 3. Cognito Authorizer
    // const userPoolIssuer = `https://cognito-idp.${Stack.of(this).region}.amazonaws.com/${props.userPool.userPoolId}`;
    // const audience = [props.userPoolClient.userPoolClientId];


    const authorizer = new HttpUserPoolAuthorizer('AuctionApiAuthorizer', props.userPool, {
      userPoolRegion: Stack.of(this).region,
      userPoolClients: [props.userPoolClient], // or specify certain clients if desired
      // authorizerType: 'JWT',
      identitySource: ['$request.header.Authorization'],
      // jwtConfiguration: {
      //   audience,
      //   userPoolIssuer
      // }
    } as HttpUserPoolAuthorizerProps);

    // 4. Create Integrations
    const auctionsIntegration = new HttpLambdaIntegration("AuctionsIntegration", auctionsLambda);
    const itemsIntegration = new HttpLambdaIntegration("ItemsIntegration", itemsLambda);
    const imagesIntegration = new HttpLambdaIntegration("ImagesIntegration", imagesLambda);
    const processItemsIntegration = new HttpLambdaIntegration("ProcessItemsIntegration", processItemsLambda);
    const ExportCatalogIntegration = new HttpLambdaIntegration("ExportCatalogIntegration", exportCatalogLambda);

    // 5. Define Routes + Require Cognito Auth
    // auctions
    this.httpApi.addRoutes({
      path: '/auctions',
      methods: [HttpMethod.GET, HttpMethod.POST],
      integration: auctionsIntegration,
      authorizer, // requires user to be logged in
    });
    this.httpApi.addRoutes({
      path: '/auctions/{auctionId}',
      methods: [HttpMethod.GET, HttpMethod.PUT, HttpMethod.DELETE],
      integration: auctionsIntegration,
      authorizer,
    });
    this.httpApi.addRoutes({
      path: '/auctions/{auctionId}/items',
      methods: [HttpMethod.GET, HttpMethod.POST],
      integration: auctionsIntegration,
      authorizer
    });

    // items
    this.httpApi.addRoutes({
      path: '/items',
      methods: [HttpMethod.GET, HttpMethod.POST],
      integration: itemsIntegration,
      authorizer,
    });
    this.httpApi.addRoutes({
      path: '/items/{itemId}',
      methods: [HttpMethod.GET, HttpMethod.PUT, HttpMethod.DELETE],
      integration: itemsIntegration,
      authorizer,
    });
    // or route items under an auction, e.g. /auctions/{auctionId}/items

    // images
    this.httpApi.addRoutes({
      path: '/images',
      methods: [HttpMethod.POST], // e.g., get presigned URLs
      integration: imagesIntegration,
      authorizer,
    });
    this.httpApi.addRoutes({
      path: '/images/{imageId}',
      methods: [HttpMethod.GET, HttpMethod.PUT, HttpMethod.DELETE],
      integration: imagesIntegration,
      authorizer,
    });
    this.httpApi.addRoutes({
      path: '/images/getPresignedUrl',
      methods: [HttpMethod.POST],
      integration: imagesIntegration,
      authorizer,
    })

    this.httpApi.addRoutes({
      path: '/processItems',
      methods: [HttpMethod.POST],
      integration: processItemsIntegration,
      authorizer,
    });

    // Process items routes
    this.httpApi.addRoutes({
      path: '/processItems/stage',
      methods: [HttpMethod.POST],
      integration: processItemsIntegration,
      authorizer,
    });

    this.httpApi.addRoutes({
      path: '/processItems/create',
      methods: [HttpMethod.POST],
      integration: processItemsIntegration,
      authorizer,
    });

    // Batch management Lambda
    const batchManagementLambda = new NodejsFunction(this, 'BatchManagementLambda', {
      entry: path.join(__dirname, '..', 'src', 'handlers', 'batch-management.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_18_X,
      environment: {
        OPENAI_SECRET_ARN: openAiSecret.secretArn,
      },
      timeout: Duration.seconds(30),
      memorySize: 256,
    });

    // Grant permissions to the batch management Lambda
    openAiSecret.grantRead(batchManagementLambda);

    // Batch management integration
    const batchManagementIntegration = new HttpLambdaIntegration("BatchManagementIntegration", batchManagementLambda);

    // Batch management routes
    this.httpApi.addRoutes({
      path: '/batches',
      methods: [HttpMethod.GET],
      integration: batchManagementIntegration,
      authorizer,
    });

    this.httpApi.addRoutes({
      path: '/batches/{batchId}',
      methods: [HttpMethod.GET],
      integration: batchManagementIntegration,
      authorizer,
    });

    this.httpApi.addRoutes({
      path: '/batches/{batchId}/results',
      methods: [HttpMethod.GET],
      integration: batchManagementIntegration,
      authorizer,
    });

    this.httpApi.addRoutes({
      path: '/batches/{batchId}/cancel',
      methods: [HttpMethod.POST],
      integration: batchManagementIntegration,
      authorizer,
    });

    // Export catalog route
    this.httpApi.addRoutes({
      path: '/export/catalog',
      methods: [HttpMethod.POST],
      integration: ExportCatalogIntegration,
      authorizer,
    });

    // Add admin-only routes
    this.httpApi.addRoutes({
      path: '/admin/users',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("AdminUsersIntegration", adminAuthorizerLambda),
      authorizer: adminAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/admin/users/{userId}',
      methods: [HttpMethod.PUT, HttpMethod.DELETE],
      integration: new HttpLambdaIntegration("AdminUserManagementIntegration", adminAuthorizerLambda),
      authorizer: adminAuthorizer,
    });

    // Add admin-only auction management routes
    this.httpApi.addRoutes({
      path: '/admin/auctions',
      methods: [HttpMethod.POST],
      integration: auctionsIntegration,
      authorizer: adminAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/admin/auctions/{auctionId}',
      methods: [HttpMethod.PUT, HttpMethod.DELETE],
      integration: auctionsIntegration,
      authorizer: adminAuthorizer,
    });

    // Add admin-only item management routes
    this.httpApi.addRoutes({
      path: '/admin/items',
      methods: [HttpMethod.POST],
      integration: itemsIntegration,
      authorizer: adminAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/admin/items/{itemId}',
      methods: [HttpMethod.PUT, HttpMethod.DELETE],
      integration: itemsIntegration,
      authorizer: adminAuthorizer,
    });

    // Add the check-admin route
    this.httpApi.addRoutes({
      path: '/auth/check-admin',
      methods: [HttpMethod.GET],
      integration: checkAdminIntegration,
      authorizer, // requires user to be logged in
    });

    // Output API endpoint
    this.exportValue(this.httpApi.apiEndpoint, { name: 'ApiEndpoint' });
  }
}
