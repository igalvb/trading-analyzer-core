import { main } from './verify/cli.ts';

process.exitCode = main(process.argv.slice(2));
