// The human-authorized prefix is shared: real-cloud test suites run serially.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
module.exports=function acquire(root){
 const dir=path.join(root,'.build-cache/cloud-evidence');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'.active-qa.lock'),token=crypto.randomUUID();
 try{fs.writeFileSync(file,JSON.stringify({pid:process.pid,token,startedAt:new Date().toISOString(),script:path.basename(process.argv[1])}),{flag:'wx'})}
 catch(e){if(e.code==='EEXIST')throw Error('Another cloud QA suite owns the authorized prefix; finish or inspect that test before retrying');throw e}
 process.once('exit',()=>{try{if(JSON.parse(fs.readFileSync(file,'utf8')).token===token)fs.unlinkSync(file)}catch{}});
};
