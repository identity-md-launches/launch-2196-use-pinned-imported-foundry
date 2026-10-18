import { readFile } from 'node:fs/promises';
const command=process.argv[2]??'status';
if(command!=='status') throw Error('This preparation CLI supports status only. No live payment command is enabled.');
const config=JSON.parse(await readFile(new URL('../config.example.json',import.meta.url),'utf8'));
console.log(JSON.stringify({mode:config.mode,chainId:config.chainId,contractConfigured:Boolean(config.contract),liveExecutionApproved:config.liveExecutionApproved,spendingEnabled:false,missing:['reviewed deployment addresses and runtime hash','owner-configured worker address','gas, reserve and daily spending limits','separately authorized deployment and activation']},null,2));
