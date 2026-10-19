import assert from 'node:assert/strict';
import { test } from 'node:test';
import { llm, type voice } from '@livekit/agents';
import { transcriptLine } from './transcript.js';

test('transcriptLine keeps messages with role and the interrupted flag', () => {
  const item = llm.ChatMessage.create({ role: 'assistant', content: 'Hallo', interrupted: true });
  const event = { type: 'conversation_item_added', item, createdAt: 1 } as voice.ConversationItemAddedEvent;
  assert.deepEqual(transcriptLine(event, 5), {
    ts: 5,
    type: 'item',
    role: 'assistant',
    interrupted: true,
    text: 'Hallo',
  });
});

test('transcriptLine skips interim transcripts', () => {
  const base = { type: 'user_input_transcribed', transcript: 'zwei', itemId: null, speakerId: null };
  const interim = { ...base, isFinal: false } as voice.UserInputTranscribedEvent;
  const final = { ...base, isFinal: true } as voice.UserInputTranscribedEvent;
  assert.equal(transcriptLine(interim, 1), null);
  assert.deepEqual(transcriptLine(final, 1), { ts: 1, type: 'stt_final', text: 'zwei' });
});

test('transcriptLine records false interruptions without text', () => {
  const event = { type: 'agent_false_interruption', resumed: true, createdAt: 1 } as voice.AgentFalseInterruptionEvent;
  assert.deepEqual(transcriptLine(event, 2), { ts: 2, type: 'false_interruption', resumed: true });
});
