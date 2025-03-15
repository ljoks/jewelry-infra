import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket, BlockPublicAccess, BucketEncryption, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement, Effect, StarPrincipal } from "aws-cdk-lib/aws-iam";


import { LayerVersion, Code, Runtime } from 'aws-cdk-lib/aws-lambda';

export class AuctionDBStack extends Stack {
  public readonly auctionsTable: Table;
  public readonly itemsTable: Table;
  public readonly imagesTable: Table;
  public readonly usersTable: Table;
  public readonly imagesBucket: Bucket;
  public readonly opencvPythonLayer: LayerVersion;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // 1. Auctions Table
    this.auctionsTable = new Table(this, 'AuctionsTable', {
      tableName: 'Auctions',
      partitionKey: { name: 'auction_id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // Dev only
    });

    // 2. Items Table
    this.itemsTable = new Table(this, 'ItemsTable', {
      tableName: 'JewelryItems',
      partitionKey: { name: 'item_id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // Dev only
    });
    // GSI: Query items by auction_id
    this.itemsTable.addGlobalSecondaryIndex({
      indexName: 'auctionIdIndex',
      partitionKey: { name: 'auction_id', type: AttributeType.STRING },
    });

    // 3. Images Table
    this.imagesTable = new Table(this, 'ImagesTable', {
      tableName: 'Images',
      partitionKey: { name: 'image_id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // Dev only
    });
    // GSI: Query images by item_id
    this.imagesTable.addGlobalSecondaryIndex({
      indexName: 'itemIdIndex',
      partitionKey: { name: 'item_id', type: AttributeType.STRING },
    });
    this.imagesTable.addGlobalSecondaryIndex({
      indexName: 'auctionIdIndex',
      partitionKey: { name: 'auction_id', type: AttributeType.STRING },
    });
    

    // 4. Users Table (Optional if you do Cognito, but included here for reference)
    this.usersTable = new Table(this, 'UsersTable', {
      tableName: 'Users',
      partitionKey: { name: 'user_id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // Dev only
    });

    this.imagesBucket = new Bucket(this, 'JewelryImagesBucket', {
      bucketName: 'my-jewelry-auctions-images-bucket', // Must be globally unique
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: {
        blockPublicAcls: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
        blockPublicPolicy: false,
      },
      removalPolicy: RemovalPolicy.DESTROY, // Dev only
      // publicReadAccess: true, // Allow objects to be publicly read
      cors: [
        {
          allowedOrigins: ['http://localhost:3000', '*'], // Allow frontend requests
          allowedMethods: [HttpMethods.GET, HttpMethods.PUT, HttpMethods.POST],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000, // Cache CORS response for 3000 seconds
        },
      ],
    });


    // Python Handlers and Associated Layers
    this.opencvPythonLayer = new LayerVersion(this, 'OpenCVPythonLayer', {
      layerVersionName: 'OpenCVPythonLayer',
      code: Code.fromAsset('layers/opencv-python/opencv-python-layer.zip'),
      compatibleRuntimes: [Runtime.PYTHON_3_9], // or whichever you need
      description: 'OpenCV (Python) for marker detection',
    });
  }
}
