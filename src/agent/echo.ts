import {
  type AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Track,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import type { JobContext } from '@livekit/agents';
import { _ } from '../i18n.js';

const SAMPLE_RATE = 48000;
const CHANNELS = 1;

/** Republish the first remote audio track: exercises the SIP and audio path without any AI key. */
export async function runEcho(ctx: JobContext): Promise<void> {
  const participant = await ctx.waitForParticipant();
  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track = LocalAudioTrack.createAudioTrack('echo', source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await ctx.room.localParticipant?.publishTrack(track, options);
  console.log(_('echo mode: waiting for audio from the caller'));

  let reader: ReadableStreamDefaultReader<AudioFrame> | undefined;

  function forward(remote: Track): void {
    // A second forwarder would interleave its frames into the same source, so the first track
    // wins and the listener goes away with it.
    if (reader) return;
    ctx.room.off('trackSubscribed', onSubscribed);
    const active = new AudioStream(remote, SAMPLE_RATE, CHANNELS).getReader();
    reader = active;
    void (async () => {
      for (;;) {
        const { value, done } = await active.read();
        if (done) return;
        await source.captureFrame(value);
      }
    })().catch((error) => console.warn(_('echo mode: forwarding stopped'), error));
  }

  function onSubscribed(remote: RemoteTrack, _publication: RemoteTrackPublication, from: RemoteParticipant): void {
    if (from.identity === participant.identity && remote.kind === TrackKind.KIND_AUDIO) forward(remote);
  }

  // The FFI feeds an audio stream until its handle is dropped, and the published track owns the
  // source: both outlive the job unless they are closed here. `reader.cancel()` also ends the
  // pending `read()`, which is how the forwarder loop finishes.
  ctx.addShutdownCallback(async () => {
    ctx.room.off('trackSubscribed', onSubscribed);
    await reader?.cancel();
    await track.close();
  });

  for (const publication of participant.trackPublications.values()) {
    if (publication.track && publication.kind === TrackKind.KIND_AUDIO) {
      forward(publication.track);
      return;
    }
  }
  ctx.room.on('trackSubscribed', onSubscribed);
}
