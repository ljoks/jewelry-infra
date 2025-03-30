import { PostConfirmationTriggerEvent, Context } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';

const dynamo = new DynamoDB.DocumentClient();
const USERS_TABLE = process.env.USERS_TABLE!;

export async function handler(event: PostConfirmationTriggerEvent, context: Context) {
  try {
    const { userName, request, response } = event;
    const { userAttributes } = request;

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

    console.log(`User ${userName} created in Users table`);

    // Return the event to allow the confirmation to proceed
    return event;
  } catch (error) {
    console.error('Error creating user:', error);
    throw error; // This will prevent the user from being confirmed
  }
} 