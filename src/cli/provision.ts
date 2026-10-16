import { RoomAgentDispatch, RoomConfiguration, SipClient } from 'livekit-server-sdk';
import { httpUrl } from '../agent/transfer.js';
import { _ } from '../i18n.js';

const TRUNK_NAME = 'sprechstunde-inbound';
const RULE_NAME = 'sprechstunde-dispatch';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(_('%s must be set').replace('%s', name));
  return value;
}

async function main(): Promise<void> {
  const client = new SipClient(
    httpUrl(required('LIVEKIT_URL')),
    required('LIVEKIT_API_KEY'),
    required('LIVEKIT_API_SECRET'),
  );
  const agentName = process.env.SPRECHSTUNDE_AGENT_NAME ?? 'sprechstunde';
  const numbers = (process.env.SPRECHSTUNDE_TRUNK_NUMBERS ?? '')
    .split(',')
    .map((number) => number.trim())
    .filter(Boolean);

  const trunks = await client.listSipInboundTrunk();
  let trunk = trunks.find((candidate) => candidate.name === TRUNK_NAME);
  if (trunk) {
    console.log(_('Inbound trunk exists:'), trunk.sipTrunkId);
  } else {
    trunk = await client.createSipInboundTrunk(TRUNK_NAME, numbers, {
      allowedAddresses: ['127.0.0.1'],
    });
    console.log(_('Inbound trunk created:'), trunk.sipTrunkId);
  }

  const rules = await client.listSipDispatchRule();
  const rule = rules.find((candidate) => candidate.name === RULE_NAME);
  if (rule?.hidePhoneNumber) {
    console.log(_('Dispatch rule exists:'), rule.sipDispatchRuleId);
    return;
  }
  // Rules from before hidePhoneNumber carry the caller's number into room names and logs; the
  // field cannot be updated in place.
  if (rule) {
    await client.deleteSipDispatchRule(rule.sipDispatchRuleId);
    console.log(_('Dispatch rule replaced:'), rule.sipDispatchRuleId);
  }
  const created = await client.createSipDispatchRule(
    { type: 'individual', roomPrefix: 'call-' },
    {
      name: RULE_NAME,
      trunkIds: [trunk.sipTrunkId],
      // Room names, participant identity and logs get the last four digits and a hash instead.
      hidePhoneNumber: true,
      roomConfig: new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName })] }),
    },
  );
  console.log(_('Dispatch rule created:'), created.sipDispatchRuleId);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
