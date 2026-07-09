import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const uri = process.env.MONGODB_URI;
console.log('Testing MongoDB URI:', uri);

try {
  const client = new MongoClient(uri);
  await client.connect();
  console.log('MongoDB connection successful');
  await client.close();
} catch (err) {
  console.error('MongoDB connection failed:', err.message);
}
