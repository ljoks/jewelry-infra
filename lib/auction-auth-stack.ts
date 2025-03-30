import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  UserPool,
  UserPoolClient,
  OAuthScope,
  UserPoolDomain,
  UserPoolEmail,
  VerificationEmailStyle,
  AccountRecovery,
} from 'aws-cdk-lib/aws-cognito';
import { RemovalPolicy } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import { Table } from 'aws-cdk-lib/aws-dynamodb';

interface AuthStackProps extends StackProps {
  usersTable: Table;
}

export class AuthStack extends Stack {
  public readonly userPool: UserPool;
  public readonly userPoolClient: UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    // Create the Lambda function for user creation
    const createUserFunction = new NodejsFunction(this, 'CreateUserFunction', {
      entry: path.join(__dirname, '..', 'src', 'handlers', 'create-user.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_LATEST,
      environment: {
        USERS_TABLE: props.usersTable.tableName,
      },
    });
    props.usersTable.grantWriteData(createUserFunction);

    // 1. Create the User Pool
    this.userPool = new UserPool(this, 'AuctionUserPool', {
      userPoolName: 'AuctionUserPool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
        username: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
        givenName: {
          required: false,
          mutable: true,
        },
        familyName: {
          required: false,
          mutable: true,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY, // Dev only
      email: UserPoolEmail.withCognito('noreply@yourdomain.com'),
      userVerification: {
        emailStyle: VerificationEmailStyle.CODE,
        emailSubject: 'Verify your email for our service!',
        emailBody: 'Thanks for signing up! Your verification code is {####}',
      },
      lambdaTriggers: {
        postConfirmation: createUserFunction,
      },
    });

    // 2. Create the User Pool Client
    this.userPoolClient = new UserPoolClient(this, 'AuctionUserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: 'AuctionUserPoolClient',
      generateSecret: false,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
    });

    // 3. (Optional) Custom Domain
    new UserPoolDomain(this, 'AuctionUserPoolDomain', {
      userPool: this.userPool,
      cognitoDomain: {
        domainPrefix: 'my-auction-users', // must be unique
      },
    });
  }
}
