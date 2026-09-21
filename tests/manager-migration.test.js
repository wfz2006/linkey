import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('manager compiles and accepts only the expected migration archive location', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkey-manager-test-'));
  try {
    const harness = path.join(dir, 'Harness.cs');
    fs.writeFileSync(harness, `using System; using System.Collections.Generic; using System.IO;
class Harness {
 static void Main() {
  string name = "Linkey-完整数据迁移包-20260908-120000.zip";
  var data = new Dictionary<string,object>{{"fileName",name},{"relativePath","dist/"+name}};
  string actual = FastQQ.ServerManager.MainForm.ResolveMigrationArchive(@"C:\\Server Folder",data);
  if(actual != Path.Combine(@"C:\\Server Folder", "dist", name)) throw new Exception("valid path rejected");
  foreach(string bad in new[]{"../"+name, "..\\\\"+name, "C:"+name, name+"\\\"", name+".exe", name+"\\n"}) {
   data["fileName"]=bad; data["relativePath"]="dist/"+bad;
   try { FastQQ.ServerManager.MainForm.ResolveMigrationArchive(@"C:\\Server Folder",data); throw new Exception("unsafe filename accepted"); }
   catch(InvalidDataException) {}
  }
  data["fileName"]=name;
  foreach(string bad in new[]{"../"+name,"dist/../"+name,"C:/dist/"+name,"dist/other.zip"}) {
   data["relativePath"]=bad;
   try { FastQQ.ServerManager.MainForm.ResolveMigrationArchive(@"C:\\Server Folder",data); throw new Exception("unsafe path accepted"); }
   catch(InvalidDataException) {}
  }
 }
}`, 'utf8');
    const executable = path.join(dir, 'Harness.exe');
    const compile = spawnSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', [
      '/nologo', '/target:exe', '/main:Harness', `/out:${executable}`,
      '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
      '/reference:System.dll', '/reference:System.Web.Extensions.dll',
      path.resolve('src_manager/FastQQServerManager.cs'), harness
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const run = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
