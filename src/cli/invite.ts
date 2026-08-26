/**
 * `ccledger invite <display-name>`.
 *
 * Produces the one string a teammate has to be sent. Everything they need is
 * inside it — where the server is and the code that lets them in — because the
 * alternative, a URL and a code as two separate things, is how half a team ends
 * up pasting the code into the endpoint field.
 *
 * The endpoint comes from the database by default. `serve` writes it there on
 * every boot, which means an admin who has started their server once never has
 * to remember what its address was.
 */

import { getConfig } from '../db/config.js';
import { createJoinCodeStore } from '../db/joincodes.js';
import { CONFIG_PUBLIC_URL, JOIN_CODE_TTL_MS } from '../shared/constants.js';
import { encodeInvite, normaliseDisplayName, normaliseEndpoint } from '../shared/invite.js';
import { PACKAGE_NAME } from '../shared/version.js';
import { openMigratedDatabase } from './database.js';
import { fail, say, warn } from './io.js';

/** Options for `ccledger invite`, as Commander hands them over. */
export interface InviteOptions {
  /** SQLite file path; the same one `serve` uses. */
  readonly db: string;
  /** Base URL to bundle. Defaults to whatever `serve` last advertised. */
  readonly endpoint?: string;
}

/** Hours in the code's lifetime, for the line that tells a teammate to hurry. */
const TTL_HOURS = Math.round(JOIN_CODE_TTL_MS / (60 * 60 * 1000));

/**
 * Issues a join code and prints the invite. Exits non-zero, with a sentence
 * saying what to do instead, if there is no endpoint to put in it.
 */
export function runInvite(rawName: string, options: InviteOptions): void {
  const displayName = normaliseDisplayName(rawName);
  if (displayName === undefined) {
    fail('the display name must be 1 to 64 printable characters');
  }

  const db = openMigratedDatabase(options.db);
  try {
    const stored = getConfig(db, CONFIG_PUBLIC_URL);
    const requested = options.endpoint ?? stored;
    if (requested === undefined) {
      fail(
        'no endpoint to invite anyone to. Run `ccledger serve` once against this ' +
          'database so it can record its URL, or pass --endpoint <url>.',
      );
    }
    const endpoint = normaliseEndpoint(requested);
    if (endpoint === undefined) {
      fail(`endpoint is not an absolute http(s) URL: ${requested}`);
    }

    const store = createJoinCodeStore(db);
    // An admin issuing a code is the natural moment to clear the ones that
    // aged out; nothing else runs on a schedule.
    store.prune();

    const joinCode = store.create(displayName);
    const invite = encodeInvite({ v: 1, endpoint, code: joinCode.code, name: displayName });

    say();
    say(`Invite for ${displayName}`);
    say();
    say(`  endpoint    ${endpoint}`);
    say(`  join code   ${joinCode.code}`);
    say(`  expires     ${new Date(joinCode.expiresAt).toISOString()}`);
    say();
    say('Send them this line:');
    say();
    say(`  npx ${PACKAGE_NAME} setup --code ${invite}`);
    say();
    say(`The code works once and expires in ${String(TTL_HOURS)} hours.`);

    // An admin who has forgotten whether they already invited someone has no
    // other way to find out; the code itself is not recoverable.
    const others = store.listOpen().filter((entry) => entry.code !== joinCode.code);
    if (others.length > 0) {
      const names = others.map((entry) => entry.displayName).join(', ');
      say(`Still unclaimed from earlier: ${String(others.length)} (${names}).`);
    }
    say();

    if (endpoint.startsWith('http://')) {
      warn(
        'this endpoint is plain HTTP — the token it hands out will cross the network ' +
          'unencrypted, so only send this invite over a network you trust',
      );
    }
  } finally {
    db.close();
  }
}
