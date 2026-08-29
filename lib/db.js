const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'wedding';

if (!uri) {
  console.warn('MONGODB_URI is not set. API calls that touch the database will fail until it is configured.');
}

// Reuse the client + connection across invocations (important on serverless
// platforms like Vercel, where a fresh connection per request is slow/costly).
let cachedClient = global._mongoClient;
let cachedDbPromise = global._mongoDbPromise;

function getDb() {
  if (!uri) {
    return Promise.reject(new Error('MONGODB_URI is not configured'));
  }
  if (!cachedClient) {
    cachedClient = new MongoClient(uri);
    global._mongoClient = cachedClient;
  }
  if (!cachedDbPromise) {
    cachedDbPromise = cachedClient.connect().then((client) => client.db(dbName));
    global._mongoDbPromise = cachedDbPromise;
  }
  return cachedDbPromise;
}

async function getGuestsCollection() {
  const db = await getDb();
  const col = db.collection('guests');
  // slug must be unique so every link is distinct
  await col.createIndex({ slug: 1 }, { unique: true }).catch(() => {});
  return col;
}

module.exports = { getDb, getGuestsCollection };
