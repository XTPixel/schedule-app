// Device authorization is local task metadata, never a committed hardware ID.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
function authorizedPhone(){
 const root=path.resolve(__dirname,'..');
 const marker=JSON.parse(fs.readFileSync(path.join(root,'.private/android-test-device.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(marker.scope,'moment-local-phone-acceptance');assert.equal(path.resolve(marker.project),root);
 const serial=process.env.MOMENT_DEVICE||marker.serial;assert.ok(serial&&!serial.startsWith('emulator-'));assert.equal(serial,marker.serial,'Only the previously authorized phone may be used');return serial;
}
module.exports={authorizedPhone};
