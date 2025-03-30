import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket, BlockPublicAccess, BucketEncryption, HttpMethods, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement, Effect, StarPrincipal, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { LayerVersion } from 'aws-cdk-lib/aws-lambda';

export class AuctionDBStack extends Stack {
  public readonly auctionsTable: Table;
  public readonly itemsTable: Table;
  public readonly imagesTable: Table;
  public readonly usersTable: Table;
  public readonly counterTable: Table;
  public readonly imagesBucket: Bucket;
  public readonly createItemFunction: Function;

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
      tableName: 'Items',
      partitionKey: { name: 'item_id', type: AttributeType.NUMBER },
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
      partitionKey: { name: 'item_id', type: AttributeType.NUMBER },
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
    // GSI: Query users by email
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'EmailIndex',
      partitionKey: { name: 'email', type: AttributeType.STRING },
    });

    this.imagesBucket = new Bucket(this, 'JewelryImagesBucket', {
      bucketName: 'my-jewelry-auctions-images-bucket', // Must be globally unique
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: new BlockPublicAccess({
        blockPublicAcls: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
        blockPublicPolicy: false
      }),
      removalPolicy: RemovalPolicy.DESTROY, // Dev only
      objectOwnership: ObjectOwnership.BUCKET_OWNER_PREFERRED,
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

    // Add bucket policy for public read access
    this.imagesBucket.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        principals: [new StarPrincipal()],
        actions: ['s3:GetObject'],
        resources: [this.imagesBucket.arnForObjects('*')],
      })
    );

    // Counter Table for Sequential IDs
    this.counterTable = new Table(this, 'CounterTable', {
      tableName: 'ItemCounters',
      partitionKey: { name: 'counter_name', type: AttributeType.STRING },
      sortKey: { name: 'counter_type', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // Dev only
    });

  }
}
