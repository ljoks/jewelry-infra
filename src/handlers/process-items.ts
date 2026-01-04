import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { DynamoDB, S3, SecretsManager } from 'aws-sdk';
import { createLogger, Logger } from '../utils/logger';

const dynamodb = new DynamoDB.DocumentClient();
const s3 = new S3();
const secretsManager = new SecretsManager();

const BUCKET_NAME = process.env.BUCKET_NAME || '';
const ITEMS_TABLE = process.env.ITEMS_TABLE || '';
const IMAGES_TABLE = process.env.IMAGES_TABLE || '';
const COUNTER_TABLE = process.env.COUNTER_TABLE || '';
const OPENAI_SECRET_ARN = process.env.OPENAI_SECRET_ARN || '';

let cachedApiKey: string | undefined;
let handlerLogger: Logger;

interface ImageInfo {
  s3Key: string;
  index: number;
}

interface ItemGroup {
  item_index: number;
  images: ImageInfo[];
}

interface ProcessItemsRequest {
  num_items: number;
  views_per_item: number;
  images: ImageInfo[];
  auction_id?: string;
  created_by: string;
  metadata?: Record<string, any>;
}

interface CreateItemsRequest {
  items: StagedItem[];
  auction_id?: string;
  created_by: string;
}

interface StagedItem {
  item_index: number;
  images: string[];
  title: string;
  description: string;
  value_estimate: {
    min_value: number;
    max_value: number;
    currency: string;
  };
  metadata: Record<string, any>;
}

interface OpenAIResponse {
  title: string;
  description: string;
  value_estimate: {
    min_value: number;
    max_value: number;
    currency: string;
  };
  discovered_metadata: {
    weight_grams: number | null;
    markings: string[];
  };
}

interface ItemData {
  item_id: number;
  item_index: number;
  metadata: Record<string, any>;
  images: string[];
  title: string;
  description: string;
  value_estimate: {
    min_value: number;
    max_value: number;
    currency: string;
  };
  created_at: number;
  updated_at: number;
  created_by: string;
  auction_id?: string;
}

interface ImageData {
  image_id: string;
  item_id: number;
  s3_key_original: string;
  created_at: number;
  auction_id?: string;
}

async function generateItemId(): Promise<number> {
  const response = await dynamodb.update({
    TableName: COUNTER_TABLE,
    Key: {
      counter_name: 'GLOBAL',
      counter_type: 'ITEM'
    },
    UpdateExpression: 'ADD #count :inc',
    ExpressionAttributeNames: {
      '#count': 'count'
    },
    ExpressionAttributeValues: {
      ':inc': 1
    },
    ReturnValues: 'UPDATED_NEW'
  }).promise();

  const newId = response.Attributes?.count || 1;
  handlerLogger?.debug('Generated item ID', { itemId: newId });
  return newId;
}

async function getOpenAIKey(): Promise<string> {
  if (cachedApiKey !== undefined) {
    handlerLogger?.debug('Using cached OpenAI API key');
    return cachedApiKey;
  }

  handlerLogger?.info('Fetching OpenAI API key from Secrets Manager');
  
  const response = await secretsManager.getSecretValue({
    SecretId: OPENAI_SECRET_ARN
  }).promise();

  if (!response.SecretString) {
    handlerLogger?.error('No API key found in secret');
    throw new Error('No API key found in secret');
  }

  const secret = JSON.parse(response.SecretString);
  if (!secret.api_key) {
    handlerLogger?.error('api_key field not found in secret');
    throw new Error('api_key not found in secret');
  }

  cachedApiKey = secret.api_key;
  handlerLogger?.info('OpenAI API key retrieved and cached');
  return secret.api_key;
}

async function generateItemDetails(imageKeys: string[], metadata: Record<string, any> = {}): Promise<OpenAIResponse> {
  handlerLogger?.info('Generating item details via OpenAI', { imageCount: imageKeys.length });
  
  const apiKey = await getOpenAIKey();

  // Construct image URLs
  const imageUrls = imageKeys.map(key => ({
    type: "image_url" as const,
    image_url: {
      url: `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`,
      detail: "low"
    }
  }));

  const promptText = `You are an expert jewelry appraiser and marketer. Based on these images, provide the following details in JSON format:

1. A concise title (maximum 60 characters) highlighting key features
2. A marketing-friendly description of the piece in plaintext
3. A value estimate considering materials, craftsmanship, condition, design complexity, and market trends
4. Discovered metadata including:
   - Weight in grams if a scale is visible in any image
   - Any markings or stamps visible on the jewelry (e.g. 14K, 925, maker's marks)

Respond in this exact JSON format:
{
    "title": "<concise title>",
    "description": "<marketing description>",
    "value_estimate": {
        "min_value": <number>,
        "max_value": <number>,
        "currency": "USD"
    },
    "discovered_metadata": {
        "weight_grams": <number or null if not visible>,
        "markings": ["<marking1>", "<marking2>", ...] or [] if none visible
    }
}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: promptText },
            ...imageUrls
          ]
        }],
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      handlerLogger?.error('OpenAI API request failed', null, { 
        status: response.status, 
        statusText: response.statusText 
      });
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      handlerLogger?.error('No content in OpenAI response', null, { data });
      throw new Error('No content in OpenAI response');
    }

    // Clean the content by removing markdown code blocks if present
    let cleanContent = content.trim();
    if (cleanContent.startsWith('```json')) {
      cleanContent = cleanContent.slice(7); // Remove ```json
    }
    if (cleanContent.endsWith('```')) {
      cleanContent = cleanContent.slice(0, -3); // Remove ```
    }
    cleanContent = cleanContent.trim();

    const result = JSON.parse(cleanContent);

    // Add disclaimer
    const DISCLAIMER_PHRASE = 
      "All photos represent the lot condition and may contain unseen imperfections in addition to " +
      "the information provided. All items are described to the best of our abilities. Please " +
      "communicate all questions and concerns prior to bidding. Please read our terms and " +
      "conditions for more details. Good luck bidding.";

    result.description = `${result.description}\n\n${DISCLAIMER_PHRASE}`;

    handlerLogger?.info('Item details generated successfully', { 
      title: result.title, 
      valueEstimate: result.value_estimate 
    });

    return result;
  } catch (error) {
    handlerLogger?.error('OpenAI API error - returning fallback values', error);
    return {
      title: "Untitled Item",
      description: "Failed to generate description.",
      value_estimate: { min_value: 0, max_value: 0, currency: "USD" },
      discovered_metadata: { weight_grams: null, markings: [] }
    };
  }
}

function groupImages(images: ImageInfo[], numItems: number, viewsPerItem: number): ItemGroup[] {
  const groups: ItemGroup[] = [];

  // Group images by item
  for (let itemNum = 0; itemNum < numItems; itemNum++) {
    const startIdx = itemNum * viewsPerItem;
    const endIdx = startIdx + viewsPerItem;
    const itemImages = images.slice(startIdx, endIdx);
    
    groups.push({
      item_index: itemNum,
      images: itemImages
    });
  }

  return groups;
}

export async function handler(event: APIGatewayProxyEventV2, context?: Context): Promise<APIGatewayProxyResultV2> {
  handlerLogger = createLogger(event, context);
  handlerLogger.logRequest(event);
  
  try {
    if (event.requestContext.http.method !== 'POST') {
      handlerLogger.warn('Method not allowed', { method: event.requestContext.http.method });
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }

    // Check which operation we're performing based on the path
    const path = event.requestContext.http.path;
    handlerLogger.info('Processing items operation', { path });
    
    if (path.endsWith('/stage')) {
      return handleStageItems(event);
    } else if (path.endsWith('/create')) {
      return handleCreateItems(event);
    } else {
      handlerLogger.warn('Unknown operation', { path });
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Unknown operation' })
      };
    }

  } catch (error: unknown) {
    handlerLogger.error('Unhandled error in process-items handler', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        detail: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
}

async function handleStageItems(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  handlerLogger.info('Handling stage items request');
  
  const body: ProcessItemsRequest = JSON.parse(event.body || '{}');
  const { num_items, views_per_item, images, metadata = {} } = body;

  if (!images?.length) {
    handlerLogger.warn('No images provided for staging');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'No images provided.' })
    };
  }

  if (!num_items) {
    handlerLogger.warn('num_items not provided');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'num_items is required.' })
    };
  }

  if (!views_per_item) {
    handlerLogger.warn('views_per_item not provided');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'views_per_item is required.' })
    };
  }

  // Validate image count
  const expectedImages = num_items * views_per_item;
  if (images.length !== expectedImages) {
    handlerLogger.warn('Image count mismatch', { 
      expected: expectedImages, 
      actual: images.length, 
      num_items, 
      views_per_item 
    });
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: `Expected ${expectedImages} images (${num_items} items × ${views_per_item} views), but got ${images.length}.`
      })
    };
  }

  handlerLogger.info('Staging items', { num_items, views_per_item, imageCount: images.length });

  // Group images by sequence
  const groups = groupImages(images, num_items, views_per_item);
  const stagedItems: StagedItem[] = [];

  // Process each group
  for (const group of groups) {
    const imageKeys = group.images.map(img => img.s3Key);
    
    handlerLogger.info('Generating item details for group', { 
      item_index: group.item_index, 
      imageCount: imageKeys.length 
    });
    // Generate item details using OpenAI
    const itemDetails = await generateItemDetails(imageKeys, metadata);

    // Create staged item
    const stagedItem: StagedItem = {
      item_index: group.item_index,
      images: imageKeys,
      title: itemDetails.title,
      description: itemDetails.description,
      value_estimate: itemDetails.value_estimate,
      metadata: {
        ...metadata,
        ...(itemDetails.discovered_metadata || {})
      }
    };

    stagedItems.push(stagedItem);
  }

  handlerLogger.info('Items staged successfully', { stagedCount: stagedItems.length });

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Items staged successfully',
      items: stagedItems
    })
  };
}

async function handleCreateItems(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  handlerLogger.info('Handling create items request');
  
  const body: CreateItemsRequest = JSON.parse(event.body || '{}');
  const { items, auction_id, created_by } = body;

  if (!items?.length) {
    handlerLogger.warn('No items provided for creation');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'No items provided.' })
    };
  }

  if (!created_by) {
    handlerLogger.warn('created_by not provided');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'created_by is required.' })
    };
  }
  
  handlerLogger.info('Creating items', { itemCount: items.length, auction_id, created_by });

  const createdItems = [];
  const now = Math.floor(Date.now() / 1000);

  // Create each item
  for (const item of items) {
    const itemId = await generateItemId();
    
    // Create item record
    const itemData: ItemData = {
      item_id: itemId,
      item_index: item.item_index,
      metadata: item.metadata,
      images: item.images,
      title: item.title,
      description: item.description,
      value_estimate: item.value_estimate,
      created_at: now,
      updated_at: now,
      created_by
    };

    if (auction_id) {
      itemData.auction_id = auction_id;
    }

    await dynamodb.put({
      TableName: ITEMS_TABLE,
      Item: itemData
    }).promise();

    // Create image records
    for (const key of item.images) {
      const imageData: ImageData = {
        image_id: `img_${now}_${Math.random().toString(36).substr(2, 9)}`,
        item_id: itemId,
        s3_key_original: key,
        created_at: now
      };

      if (auction_id) {
        imageData.auction_id = auction_id;
      }

      await dynamodb.put({
        TableName: IMAGES_TABLE,
        Item: imageData
      }).promise();
    }

    createdItems.push(itemData);
    handlerLogger.info('Item created', { itemId: itemData.item_id, imageCount: item.images.length });
  }

  handlerLogger.info('All items created successfully', { createdCount: createdItems.length });

  return {
    statusCode: 201,
    body: JSON.stringify({
      message: 'Items created successfully',
      items: createdItems
    })
  };
} 