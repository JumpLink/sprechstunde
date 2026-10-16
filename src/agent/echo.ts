import {
  AudioSource,
  AudioStream,
  LocalAudioTrack,
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

  const forward = async (remote: Track) => {
    for await (const frame of new AudioStream(remote, SAMPLE_RATE, CHANNELS)) {
      await source.captureFrame(frame);
    }
  };

  for (const publication of participant.trackPublications.values()) {
    if (publication.track && publication.kind === TrackKind.KIND_AUDIO) {
      void forward(publication.track);
      return;
    }
  }
  ctx.room.on('trackSubscribed', (remote, _publication, from) => {
    if (from.identity === participant.identity && remote.kind === TrackKind.KIND_AUDIO) void forward(remote);
  });
}
