import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  UserPool,
  UserPoolClient,
  OAuthScope,
  UserPoolDomain,
} from 'aws-cdk-lib/aws-cognito';
import { RemovalPolicy } from 'aws-cdk-lib';

export class AuthStack extends Stack {
  public readonly userPool: UserPool;
  public readonly userPoolClient: UserPoolClient;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // 1. Create the User Pool
    this.userPool = new UserPool(this, 'AuctionUserPool', {
      userPoolName: 'AuctionUserPool',
      removalPolicy: RemovalPolicy.DESTROY, // Dev only
      signInAliases: {
        username: true,
        email: true,
      },
      selfSignUpEnabled: true,
      // passwordPolicy, mfa, etc. can be configured here
    });

    // 2. Create the User Pool Client
    this.userPoolClient = this.userPool.addClient('AuctionUserPoolClient', {
      generateSecret: false,
      // For SPA usage, you can enable OAuth flows, specify callback URLs, etc.
      // If you want to do password auth, the default is fine.
      // Example:
      // oAuth: {
      //   flows: {
      //     implicitCodeGrant: true
      //   },
      //   scopes: [OAuthScope.OPENID, OAuthScope.EMAIL],
      //   callbackUrls: ['http://localhost:3000/callback'],
      // },
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
