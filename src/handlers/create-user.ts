import { PostConfirmationTriggerEvent, Context } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import { createLogger } from '../utils/logger';

const dynamo = new DynamoDB.DocumentClient();
const USERS_TABLE = process.env.USERS_TABLE!;

export async function handler(event: PostConfirmationTriggerEvent, context: Context) {
  const log = createLogger(event, context);
  
  try {
    const { userName, request, response } = event;
    const { userAttributes } = request;

    log.info('Creating user from Cognito post-confirmation', { 
      userName, 
      email: userAttributes.email,
      triggerSource: event.triggerSource 
    });

    // Create user record in DynamoDB
    await dynamo.put({
      TableName: USERS_TABLE,
      Item: {
        user_id: userName,
        email: userAttributes.email,
        is_admin: false, // Default to non-admin
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        // You can add more user attributes here as needed
        name: userAttributes.name,
        phone_number: userAttributes.phone_number,
        email_verified: userAttributes.email_verified === 'true',
        sub: userAttributes.sub
      }
    }).promise();

    log.info('User successfully created in Users table', { userName, email: userAttributes.email });

    // Return the event to allow the confirmation to proceed
    return event;
  } catch (error) {
    log.error('Error creating user - confirmation will fail', error, { 
      userName: event.userName,
      email: event.request?.userAttributes?.email 
    });
    throw error; // This will prevent the user from being confirmed
  }
} 