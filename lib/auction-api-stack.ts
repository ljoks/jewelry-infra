import { Stack, StackProps, Duration, SecretValue } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { HttpApi, HttpMethod, CorsHttpMethod } from '@aws-cdk/aws-apigatewayv2-alpha';
import { HttpLambdaIntegration } from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
import { HttpUserPoolAuthorizer, HttpUserPoolAuthorizerProps } from '@aws-cdk/aws-apigatewayv2-authorizers-alpha';

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
    props.itemsTable.grantReadData(imagesLambda); // if referencing items
    props.imagesBucket.grantReadWrite(imagesLambda);

    const groupImagesLambda = new LambdaFunction(this, 'GroupImagesLambda', {
      runtime: Runtime.PYTHON_3_9,
      code: Code.fromAsset('src/python_handlers'), // or from 'src/group_images' if you prefer
      handler: 'group_images.lambda_handler',
      layers: [LayerVersion.fromLayerVersionArn(this, 'GroupImagesLayer', 'arn:aws:lambda:us-east-1:424657137073:layer:opencv-python-headless:2')],
      environment: {
        BUCKET_NAME: props.imagesBucket.bucketName
      },
      timeout: Duration.seconds(30)
    });
    props.imagesBucket.grantReadWrite(groupImagesLambda);

    // Import or look up your existing secret. 
    const openAiSecret = Secret.fromSecretNameV2(this, 'OPENAI_API_KEY', 'OPENAI_API_KEY');


    // 2) finalize_items.py Lambda
    const finalizeItemsLambda = new LambdaFunction(this, 'FinalizeItemsLambda', {
      runtime: Runtime.PYTHON_3_9,
      code: Code.fromAsset('src/python_handlers'),
      handler: 'finalize_items.lambda_handler',
      layers: [LayerVersion.fromLayerVersionArn(this, 'FinalizeItemsLayer', 'arn:aws:lambda:us-east-1:424657137073:layer:opencv-python-headless:2')],
      environment: {
        BUCKET_NAME: props.imagesBucket.bucketName,
        ITEMS_TABLE: props.itemsTable.tableName,
        IMAGES_TABLE: props.imagesTable.tableName,
        COUNTER_TABLE: props.counterTable.tableName,
        OPENAI_SECRET_ARN: openAiSecret.secretArn,
      },
      timeout: Duration.seconds(30)
    });
    props.imagesBucket.grantReadWrite(finalizeItemsLambda);
    props.itemsTable.grantReadWriteData(finalizeItemsLambda);
    props.imagesTable.grantReadWriteData(finalizeItemsLambda);
    props.counterTable.grantReadWriteData(finalizeItemsLambda);
    openAiSecret.grantRead(finalizeItemsLambda);

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
    const groupImagesIntegration = new HttpLambdaIntegration("GroupImagesIntegration", groupImagesLambda);
    const FinalizeItemsIntegration = new HttpLambdaIntegration("FinalizeItemsIntegration", finalizeItemsLambda);
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
      path: '/groupImages',
      methods: [HttpMethod.POST],
      integration: groupImagesIntegration,
      authorizer,
    });

    this.httpApi.addRoutes({
      path: '/finalizeItems',
      methods: [HttpMethod.POST],
      integration: FinalizeItemsIntegration,
      authorizer,
    });

    // Export catalog route
    this.httpApi.addRoutes({
      path: '/export/catalog',
      methods: [HttpMethod.POST],
      integration: ExportCatalogIntegration,
      authorizer,
    });

    // Output API endpoint
    this.exportValue(this.httpApi.apiEndpoint, { name: 'ApiEndpoint' });
  }
}
