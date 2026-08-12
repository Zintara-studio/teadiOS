// Stands in for Remotion (or the headless agent) so the loop can be proved
// before real work is involved. Behaviour is chosen by FAKE_MODE, which the
// test sets per job through the worker's command configuration.
//
//   ok           print, write a plausible MP4, exit 0
//   no-artifact  print, exit 0, produce nothing — the cheerful liar
//   empty        write a zero-byte file and claim success
//   not-video    write a large file that is not an MP4
//   fail         exit non-zero
//   hang         print, then never exit (for cancellation)
//   leak         print secrets, to prove the feed sanitiser holds
//   noisy        print more lines than the cap allows

import { writeFileSync } from 'node:fs';

const artifact = process.argv[2];
const job = JSON.parse(process.env.TEADIO_JOB ?? '{}');
// Carried in the job's props, because the worker deliberately does NOT pass its
// own environment through to a child — so FAKE_MODE could never reach us there.
const mode = job.props?.mode ?? 'ok';

const say = (s) => process.stdout.write(s + '\n');

// A minimal but genuine MP4 header: 'ftyp' box at offset 4, then filler.
function writeVideo(path, bytes = 4096) {
  const head = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
  writeFileSync(path, Buffer.concat([head, Buffer.alloc(bytes - head.length, 0x21)]));
}

say(`fake-agent starting for ${job.slug ?? 'unknown'} (${job.kind ?? '?'}) mode=${mode}`);

switch (mode) {
  case 'hang':
    say('rendering, this will take a while');
    setInterval(() => say('still rendering'), 200);
    break;

  case 'fail':
    process.stderr.write('remotion: composition "missing" not found\n');
    process.exit(3);

  case 'no-artifact':
    say('render complete! the video is ready.');   // it is not
    process.exit(0);

  case 'empty':
    writeFileSync(artifact, '');
    say('render complete');
    process.exit(0);

  case 'not-video':
    writeFileSync(artifact, 'x'.repeat(8192));
    say('render complete');
    process.exit(0);

  case 'leak':
    say('connecting to postgresql://teadio_w1:hunter2@db.example.com/neondb');
    say('using key sk-ant-api03-AAAABBBBCCCCDDDDEEEE');
    say('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmno');
    // Supplied by the test: the worker's real database password, to prove the
    // sanitiser redacts our own secrets and not just credential-shaped strings.
    if (job.props?.leak) say(`config dump: ${job.props.leak}`);
    writeVideo(artifact);
    process.exit(0);

  case 'noisy':
    for (let i = 0; i < 2500; i++) say(`frame ${i}/2500`);
    writeVideo(artifact);
    process.exit(0);

  default:
    say('bundling composition');
    say('rendering 900 frames');
    writeVideo(artifact);
    say('render complete');
    process.exit(0);
}
