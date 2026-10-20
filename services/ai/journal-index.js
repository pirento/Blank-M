/**
 * Private journal search index: builds documents from a member's trades,
 * strategies, rules and chat, keeps their embeddings in MongoDB and ranks them
 * by cosine similarity.
 */
import { createHash } from 'node:crypto';
import { ChatMessage, JournalEmbedding, Strategy, Trade, TradingRule } from '../../models/index.js';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from './config.js';
import { openAiClient, providerRequest } from './openai.js';

function journalDocument(sourceType, sourceId, title, text) {
  return {
    sourceType,
    sourceId,
    title,
    text,
    hash: createHash('sha256').update(text).digest('hex'),
  };
}

/**
 * Builds hashed search documents from the member's latest trades (300), strategies, rules and chat
 * messages (200 each).
 */
export async function loadJournalDocuments(userId) {
  const [trades, strategies, rules, chat] = await Promise.all([
    Trade.find({ userId }).sort({ tradeDate: -1, _id: -1 }).limit(300).lean(),
    Strategy.find({ userId }).sort({ tradeDate: -1, _id: -1 }).limit(200).lean(),
    TradingRule.find({ userId }).sort({ position: 1, _id: 1 }).limit(200).lean(),
    ChatMessage.find({ userId }).sort({ createdAt: -1, _id: -1 }).limit(200).lean(),
  ]);
  return [
    ...trades.map((row) =>
      journalDocument(
        'trade',
        row._id,
        `${row.symbol} · ${row.tradeDate}`,
        `${row.tradeDate} ${row.symbol} ${row.direction}; entry ${row.entryPrice}; exit ${row.exitPrice}; quantity ${row.quantity}; net P&L ${row.netPnl}; notes ${row.notes || ''}`,
      ),
    ),
    ...strategies.map((row) =>
      journalDocument(
        'strategy',
        row._id,
        row.name,
        `${row.tradeDate} strategy ${row.name}; rules ${row.rules}; improvements ${row.improvements}; notes ${row.notes}`,
      ),
    ),
    ...rules.map((row) =>
      journalDocument(
        'rule',
        row._id,
        row.section,
        `${row.section}; definition ${row.definition}; rule ${row.rule}`,
      ),
    ),
    ...chat.map((row) =>
      journalDocument(
        'chat',
        row._id,
        `${row.role === 'assistant' ? 'AI review' : 'Journal question'} · ${new Date(row.createdAt).toISOString().slice(0, 10)}`,
        row.text,
      ),
    ),
  ];
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
}

/**
 * Brings the member's stored embeddings in line with `documents`: deletes orphans and embeds only
 * new or changed documents via the OpenAI embeddings API, in batches of 100.
 */
export async function syncJournalEmbeddings(userId, documents) {
  const rows = await JournalEmbedding.find(
    { userId },
    { sourceType: 1, sourceId: 1, contentHash: 1 },
  ).lean();
  const existing = new Map(
    rows.map((row) => [`${row.sourceType}:${row.sourceId}`, row.contentHash]),
  );
  const current = new Set(
    documents.map((document) => `${document.sourceType}:${document.sourceId}`),
  );
  // Records deleted from the journal must not keep their embeddings.
  const orphans = rows.filter((row) => !current.has(`${row.sourceType}:${row.sourceId}`));
  if (orphans.length) {
    await JournalEmbedding.deleteMany({ userId, _id: { $in: orphans.map((row) => row._id) } });
  }
  // The hash names the vector size, so vectors of an older size are embedded again.
  const stamped = (hash) => `${EMBEDDING_DIMENSIONS}:${hash}`;
  const changed = documents.filter(
    (document) =>
      existing.get(`${document.sourceType}:${document.sourceId}`) !== stamped(document.hash),
  );
  for (let offset = 0; offset < changed.length; offset += 100) {
    const batch = changed.slice(offset, offset + 100);
    const provider = openAiClient();
    const result = await providerRequest(() =>
      provider.embeddings.create({
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        input: batch.map((document) => document.text.slice(0, 12000)),
        encoding_format: 'float',
      }),
    );
    await Promise.all(
      batch.map(async (document, index) => {
        const embedding = result.data[index]?.embedding;
        if (!embedding) throw new Error('OpenAI did not return a journal embedding.');
        await JournalEmbedding.updateOne(
          { userId, sourceType: document.sourceType, sourceId: document.sourceId },
          { $set: { contentHash: stamped(document.hash), embedding: embedding.map(Number) } },
          { upsert: true },
        );
      }),
    );
  }
}

/** Nearest owner journal sources by cosine similarity. */
export async function searchJournalEmbeddings(userId, vector, limit) {
  const rows = await JournalEmbedding.find({ userId }).lean();
  return rows
    .map((row) => ({
      source_type: row.sourceType,
      source_id: row.sourceId,
      similarity: cosineSimilarity(row.embedding, vector),
    }))
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, Math.min(Math.max(limit, 1), 12));
}
