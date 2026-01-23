import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import { createLogger } from '../utils/logger';
import { requireAdmin, getUserIdFromEvent } from '../utils/admin-check';

const dynamo = new DynamoDB.DocumentClient();
const METADATA_OPTIONS_TABLE = process.env.METADATA_OPTIONS_TABLE!;
const CONFIG_KEY = 'METADATA_OPTIONS';

// Default metadata options (returned when no configuration exists)
const DEFAULT_METADATA_OPTIONS = {
  lotTypes: [
    'Ring',
    'Necklace',
    'Bangle/Cuff',
    'Bracelet',
    'Pair',
    'Set',
    'Brooch',
    'Pendant',
    'Charm',
    'Pin',
    'Buckle/Clip',
    'Belt',
    'Watch',
    'Lighter',
    'Case',
    'Other'
  ],
  materials: [
    'XRF Analyzer Tested 999 Silver',
    'XRF Analyzer Tested Sterling/925 Silver',
    'XRF Analyzer Tested 900 Silver',
    'XRF Analyzer Tested 800 Silver',
    'XRF Analyzer Tested 22k Gold',
    'XRF Analyzer Tested 18k Gold',
    'XRF Analyzer Tested 14k Gold',
    'XRF Analyzer Tested 12k Gold',
    'XRF Analyzer Tested 10k Gold',
    'XRF Analyzer Tested Platinum'
  ],
  sizes: {
    'Ring': ['Adjustable', 'Toe', '2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0', '5.5', '6.0', '6.5', '7.0', '7.5', '8.0', '8.5', '9.0', '9.5', '10.0', '10.5', '11.0', '11.5', '12.0', '12.5', '13.0', '13.5', '14.0'],
    'Necklace': ['12 inch', '13 inch', '14 inch', '15 inch', '16 inch', '17 inch', '18 inch', '19 inch', '20 inch', '21 inch', '22 inch', '23 inch', '24 inch', '25 inch', '26 inch', '27 inch', '28 inch', '29 inch', '30 inch', '31 inch', '32 inch', '33 inch', '34 inch', '35 inch', '36 inch', '37 inch', '38 inch', '39 inch', '40 inch'],
    'Bangle/Cuff': ['2.00 inch Diameter', '2.25 inch Diameter', '2.50 inch Diameter', '2.75 inch Diameter', '3.00 inch Diameter', '3.25 inch Diameter', '3.50 inch Diameter'],
    'Bracelet': ['5.5 inch', '6.0 inch', '6.5 inch', '7.0 inch', '7.5 inch', '8.0 inch', '8.5 inch', '9.0 inch', '9.5 inch', '10.0 inch', '10.5 inch', '11.0 inch'],
    'Pair': ['Earrings', 'Cuff Links'],
    'Set': ['n/a'],
    'Brooch': ['n/a'],
    'Pendant': ['Small', 'Medium', 'Large'],
    'Charm': ['n/a'],
    'Pin': ['n/a'],
    'Buckle/Clip': ['n/a'],
    'Belt': ['n/a'],
    'Watch': ['n/a'],
    'Lighter': ['n/a'],
    'Case': ['n/a'],
    'Other': ['Small', 'Medium', 'Large']
  }
};

interface ValidationErrors {
  [key: string]: string;
}

function buildResponse(statusCode: number, data: any): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

function validateMetadataOptions(body: any): { valid: boolean; errors: ValidationErrors } {
  const errors: ValidationErrors = {};

  // Validate lotTypes if provided
  if (body.lotTypes !== undefined) {
    if (!Array.isArray(body.lotTypes)) {
      errors.lotTypes = 'Must be an array';
    } else {
      // Check for empty strings
      const hasEmpty = body.lotTypes.some((item: any) => typeof item !== 'string' || item.trim() === '');
      if (hasEmpty) {
        errors.lotTypes = 'Array contains empty or invalid strings';
      } else {
        // Check for duplicates
        const unique = new Set(body.lotTypes);
        if (unique.size !== body.lotTypes.length) {
          errors.lotTypes = 'Array contains duplicate values';
        }
      }
    }
  }

  // Validate materials if provided
  if (body.materials !== undefined) {
    if (!Array.isArray(body.materials)) {
      errors.materials = 'Must be an array';
    } else {
      // Check for empty strings
      const hasEmpty = body.materials.some((item: any) => typeof item !== 'string' || item.trim() === '');
      if (hasEmpty) {
        errors.materials = 'Array contains empty or invalid strings';
      } else {
        // Check for duplicates
        const unique = new Set(body.materials);
        if (unique.size !== body.materials.length) {
          errors.materials = 'Array contains duplicate values';
        }
      }
    }
  }

  // Validate sizes if provided
  if (body.sizes !== undefined) {
    if (typeof body.sizes !== 'object' || Array.isArray(body.sizes) || body.sizes === null) {
      errors.sizes = 'Must be an object';
    } else {
      // Validate each lot type's size array
      for (const [lotType, sizeArray] of Object.entries(body.sizes)) {
        if (!Array.isArray(sizeArray)) {
          errors[`sizes.${lotType}`] = 'Must be an array';
        } else {
          // Check for empty strings
          const hasEmpty = (sizeArray as any[]).some((item: any) => typeof item !== 'string' || item.trim() === '');
          if (hasEmpty) {
            errors[`sizes.${lotType}`] = 'Array contains empty or invalid strings';
          } else {
            // Check for duplicates
            const unique = new Set(sizeArray);
            if (unique.size !== sizeArray.length) {
              errors[`sizes.${lotType}`] = 'Size array contains duplicate values';
            }
          }
        }
      }
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors
  };
}

async function getMetadataOptions(): Promise<typeof DEFAULT_METADATA_OPTIONS> {
  try {
    const result = await dynamo.get({
      TableName: METADATA_OPTIONS_TABLE,
      Key: { config_key: CONFIG_KEY }
    }).promise();

    if (result.Item && result.Item.config) {
      return result.Item.config;
    }

    // Return defaults if no configuration exists
    return DEFAULT_METADATA_OPTIONS;
  } catch (error) {
    // If table doesn't exist or other error, return defaults
    return DEFAULT_METADATA_OPTIONS;
  }
}

async function updateMetadataOptions(updates: any, userId: string): Promise<typeof DEFAULT_METADATA_OPTIONS> {
  // Get existing configuration
  const existing = await getMetadataOptions();

  // Merge updates with existing configuration
  const updated = {
    lotTypes: updates.lotTypes !== undefined ? updates.lotTypes : existing.lotTypes,
    materials: updates.materials !== undefined ? updates.materials : existing.materials,
    sizes: updates.sizes !== undefined ? updates.sizes : existing.sizes
  };

  const now = new Date().toISOString();

  // Save to database
  await dynamo.put({
    TableName: METADATA_OPTIONS_TABLE,
    Item: {
      config_key: CONFIG_KEY,
      config: updated,
      updated_at: now,
      updated_by: userId
    }
  }).promise();

  return updated;
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  context: Context
): Promise<APIGatewayProxyResultV2> {
  const log = createLogger(event, context);
  log.logRequest(event);

  try {
    const { routeKey } = event;

    // Require admin access for all operations
    const adminCheck = await requireAdmin(event);
    const userId = adminCheck.userId;

    if (routeKey === 'GET /admin/metadata-options') {
      log.info('Fetching metadata options', { userId });

      const options = await getMetadataOptions();

      log.info('Metadata options fetched successfully');
      return buildResponse(200, options);
    }

    if (routeKey === 'PUT /admin/metadata-options') {
      log.info('Updating metadata options', { userId });

      if (!event.body) {
        log.warn('PUT /admin/metadata-options called without body');
        return buildResponse(400, { error: 'Request body required' });
      }

      let body;
      try {
        body = JSON.parse(event.body);
      } catch (parseError) {
        log.warn('Invalid JSON in request body');
        return buildResponse(400, { error: 'Invalid JSON in request body' });
      }

      // Validate request body
      const validation = validateMetadataOptions(body);
      if (!validation.valid) {
        log.warn('Validation failed', { errors: validation.errors });
        return buildResponse(400, {
          error: 'Validation failed',
          details: validation.errors
        });
      }

      // Update metadata options
      const updated = await updateMetadataOptions(body, userId);

      log.info('Metadata options updated successfully', { userId });
      return buildResponse(200, updated);
    }

    log.warn('Route not found', { routeKey });
    return buildResponse(404, { error: 'Route not found' });
  } catch (error) {
    log.error('Unhandled error in metadata-options handler', error);
    return buildResponse(500, { error: 'Internal server error' });
  }
}

