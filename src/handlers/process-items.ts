import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDB, S3, SecretsManager } from 'aws-sdk';

const dynamodb = new DynamoDB.DocumentClient();
const s3 = new S3();
const secretsManager = new SecretsManager();

const BUCKET_NAME = process.env.BUCKET_NAME || '';
const ITEMS_TABLE = process.env.ITEMS_TABLE || '';
const IMAGES_TABLE = process.env.IMAGES_TABLE || '';
const COUNTER_TABLE = process.env.COUNTER_TABLE || '';
const OPENAI_SECRET_ARN = process.env.OPENAI_SECRET_ARN || '';

let cachedApiKey: string | undefined;

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
  item_id: string;
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
  item_id: string;
  s3_key_original: string;
  created_at: number;
  auction_id?: string;
}

async function generateItemId(): Promise<string> {
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

  return response.Attributes?.count.toString() || '';
}

async function getOpenAIKey(): Promise<string> {
  if (cachedApiKey !== undefined) {
    return cachedApiKey;
  }

  const response = await secretsManager.getSecretValue({
    SecretId: OPENAI_SECRET_ARN
  }).promise();

  if (!response.SecretString) {
    throw new Error('No API key found in secret');
  }

  const secret = JSON.parse(response.SecretString);
  if (!secret.api_key) {
    throw new Error('api_key not found in secret');
  }

  cachedApiKey = secret.api_key;
  return secret.api_key;
}

async function generateItemDetails(imageKeys: string[], metadata: Record<string, any> = {}): Promise<OpenAIResponse> {
  const apiKey = await getOpenAIKey();

  // Construct image URLs
  const imageUrls = imageKeys.map(key => ({
    type: "image_url" as const,
    image_url: {
      url: `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`
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
}${metadata ? `\n\nExisting Metadata:\n${JSON.stringify(metadata, null, 2)}` : ''}`;

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
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('No content in OpenAI response');
    }

    const result = JSON.parse(content.trim());

    // Add disclaimer
    const DISCLAIMER_PHRASE = 
      "All photos represent the lot condition and may contain unseen imperfections in addition to " +
      "the information provided. All items are described to the best of our abilities. Please " +
      "communicate all questions and concerns prior to bidding. Please read our terms and " +
      "conditions for more details. Good luck bidding.";

    result.description = `${result.description}\n\n${DISCLAIMER_PHRASE}`;

    return result;
  } catch (error) {
    console.error('OpenAI API error:', error);
    return {
      title: "Untitled Item",
      description: "Failed to generate description.",
      value_estimate: { min_value: 0, max_value: 0, currency: "USD" },
      discovered_metadata: { weight_grams: null, markings: [] }
    };
  }
}

function groupImages(images: ImageInfo[], numItems: number, viewsPerItem: number): ItemGroup[] {
  const groups: Record<number, ItemGroup> = {};

  // Initialize groups
  for (let itemNum = 0; itemNum < numItems; itemNum++) {
    groups[itemNum] = {
      item_index: itemNum,
      images: []
    };
  }

  // Group images by sequence
  for (let viewNum = 0; viewNum < viewsPerItem; viewNum++) {
    const viewOffset = viewNum * numItems;
    
    for (let itemNum = 0; itemNum < numItems; itemNum++) {
      const imgIdx = viewOffset + itemNum;
      const imgInfo = images[imgIdx];
      
      if (imgInfo?.s3Key) {
        groups[itemNum].images.push({
          index: imgIdx,
          s3Key: imgInfo.s3Key
        });
      }
    }
  }

  return Object.values(groups);
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    if (event.requestContext.http.method !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }

    const body: ProcessItemsRequest = JSON.parse(event.body || '{}');
    const { num_items, views_per_item, images, auction_id, created_by, metadata = {} } = body;

    if (!images?.length) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No images provided.' })
      };
    }

    if (!num_items) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'num_items is required.' })
      };
    }

    if (!views_per_item) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'views_per_item is required.' })
      };
    }

    if (!created_by) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'created_by is required.' })
      };
    }

    // Validate image count
    const expectedImages = num_items * views_per_item;
    if (images.length !== expectedImages) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Expected ${expectedImages} images (${num_items} items × ${views_per_item} views), but got ${images.length}.`
        })
      };
    }

    // Group images by sequence
    const groups = groupImages(images, num_items, views_per_item);
    const createdItems = [];
    const now = Math.floor(Date.now() / 1000);

    // Process each group
    for (const group of groups) {
      const imageKeys = group.images.map(img => img.s3Key);
      const itemId = await generateItemId();
      
      // Generate item details using OpenAI
      const itemDetails = await generateItemDetails(imageKeys, metadata);

      // Merge discovered metadata
      const finalMetadata = {
        ...metadata,
        ...(itemDetails.discovered_metadata || {})
      };

      // Create item record
      const itemData: ItemData = {
        item_id: itemId,
        item_index: group.item_index,
        metadata: finalMetadata,
        images: imageKeys,
        title: itemDetails.title,
        description: itemDetails.description,
        value_estimate: itemDetails.value_estimate,
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
      for (const key of imageKeys) {
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
    }

    return {
      statusCode: 201,
      body: JSON.stringify({
        message: 'Items processed successfully',
        items: createdItems
      })
    };

  } catch (error: unknown) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        detail: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
} 