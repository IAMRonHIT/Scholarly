#!/usr/bin/env node
import AWS from 'aws-sdk';
import dotenv from 'dotenv';

dotenv.config();

const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_SESSION_TOKEN = process.env.AWS_SESSION_TOKEN;
const AWS_REGION = process.env.AWS_REGION;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;

if (!AWS_S3_BUCKET) {
  console.error('AWS_S3_BUCKET environment variable is required');
  process.exit(1);
}

// Configure AWS
AWS.config.update({
  accessKeyId: AWS_ACCESS_KEY_ID,
  secretAccessKey: AWS_SECRET_ACCESS_KEY,
  sessionToken: AWS_SESSION_TOKEN,
  region: AWS_REGION
});

const s3 = new AWS.S3();

async function clearBucket() {
  console.log(`Clearing bucket: ${AWS_S3_BUCKET}`);

  try {
    // List all objects in the bucket
    const listParams = {
      Bucket: AWS_S3_BUCKET
    };

    const listedObjects = await s3.listObjectsV2(listParams).promise();

    if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
      console.log('Bucket is already empty');
      return;
    }

    console.log(`Found ${listedObjects.Contents.length} objects to delete`);

    // Create delete parameters
    const deleteParams = {
      Bucket: AWS_S3_BUCKET,
      Delete: {
        Objects: listedObjects.Contents.map(({ Key }) => ({ Key: Key! })),
        Quiet: false
      }
    };

    // Delete objects
    const deleted = await s3.deleteObjects(deleteParams).promise();
    console.log(`Successfully deleted ${deleted.Deleted?.length} objects`);

    // If there might be more objects (truncated), recursively delete them
    if (listedObjects.IsTruncated) {
      await clearBucket();
    }

  } catch (error) {
    console.error('Error clearing bucket:', error);
    process.exit(1);
  }
}

// Execute the bucket clearing
clearBucket()
  .then(() => console.log('Bucket clearing completed successfully'))
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
