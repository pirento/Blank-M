/**
 * POST /api/ai/transcribe: voice-note transcription. Temporary uploads are
 * deleted after use (and by the daily cleanup job).
 */
import { toFile } from 'openai';
import { readJsonBody, requireMethod } from '../../services/http.js';
import { authenticateRequest } from '../../services/auth/request-auth.js';
import { downloadObject, removeObjects } from '../../services/storage.js';
import { enforceAiRateLimit, recordAiUsage } from '../../services/ai/usage-limits.js';
import { TRANSCRIPTION_MODEL } from '../../services/ai/config.js';
import { transcribeRequestSchema, transcriptionResponseSchema } from '../../shared/ai-schemas.js';
import {
  ALLOWED_AUDIO_MIME,
  MAX_AUDIO_BYTES,
  assertAttachmentOwnership,
  handleFailure,
} from './shared.js';
import { AiResponseFailure, openAiClient } from '../../services/ai/openai.js';
import { createLogger } from '../../services/logger.js';

const log = createLogger('ai');

/** Throws 415 for an unsupported audio type, 400 when empty and 413 above 10 MB. */
export function assertAudioFile(mime, byteLength) {
  if (!ALLOWED_AUDIO_MIME.has(mime)) {
    throw Object.assign(new Error('This voice-note format is not supported.'), { status: 415 });
  }
  if (!byteLength) {
    throw Object.assign(new Error('The voice note is empty.'), { status: 400 });
  }
  if (byteLength > MAX_AUDIO_BYTES) {
    throw Object.assign(new Error('Voice notes must be 10 MB or smaller.'), { status: 413 });
  }
}

/**
 * POST /api/ai/transcribe: transcribes an uploaded voice note the member owns. The upload
 * is deleted afterwards whatever the outcome; 422 when no speech is detected.
 */
export async function handleTranscribe(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  let userId = '';
  try {
    const { user } = await authenticateRequest(req);
    userId = user.id;
    await enforceAiRateLimit(user.id);
    const body = transcribeRequestSchema.parse(readJsonBody(req));
    assertAttachmentOwnership(body.audioPath, user.id);
    let transcript;
    try {
      const data = await downloadObject('voice-notes', body.audioPath);
      if (!data) {
        throw Object.assign(new Error('The voice note could not be read.'), { status: 404 });
      }
      const bytes = data.buffer;
      assertAudioFile(body.mime, bytes.byteLength);
      const client = openAiClient();
      const file = await toFile(bytes, body.filename, { type: body.mime });
      try {
        transcript = await client.audio.transcriptions.create({
          file,
          model: TRANSCRIPTION_MODEL,
          response_format: 'json',
        });
      } catch {
        // SDK 4xx diagnostics can contain request/provider data. Keep the
        // intentional local validation errors, but never echo upstream text.
        throw new AiResponseFailure();
      }
      const parsed = transcriptionResponseSchema.safeParse({ transcript: transcript.text });
      if (!parsed.success) throw new AiResponseFailure();
      if (!parsed.data.transcript.trim())
        throw Object.assign(
          new Error('No speech was detected. Record a voice note and try again.'),
          { status: 422 },
        );
    } finally {
      try {
        await removeObjects('voice-notes', [body.audioPath]);
      } catch {
        // Cleanup must not mask the transcription outcome. Scheduled retention
        // also covers failed removal and abandoned browser uploads.
        log.warn('temporary voice-note cleanup requires maintenance');
      }
    }
    await recordAiUsage({
      userId,
      feature: 'transcribe',
      model: TRANSCRIPTION_MODEL,
      status: 'completed',
    }).catch(() => undefined);
    res.status(200).json({ transcript: transcript.text });
  } catch (error) {
    if (userId) {
      await recordAiUsage({
        userId,
        feature: 'transcribe',
        model: TRANSCRIPTION_MODEL,
        status: 'failed',
      }).catch(() => undefined);
    }
    handleFailure(res, error);
  }
}
