#!/usr/bin/env python3
"""Create a source+Windows-core handoff snapshot, excluding runtime secrets and caches."""
import argparse,hashlib,json,subprocess,zipfile
from pathlib import Path

def main():
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--windows-core',type=Path,required=True);p.add_argument('--ca',type=Path,required=True);args=p.parse_args()
 if args.output.exists():p.error('Output already exists; use a new artifact name')
 root=Path(__file__).resolve().parents[1]
 names=subprocess.check_output(['git','ls-files','-c','-o','--exclude-standard','-z'],cwd=root).decode().split('\0')
 allow_prefix=('cmd/','lib/','internal/','gui/','proto/','assets/','script/','test/','meta/','desktop/','docs/')
 files={}
 for name in sorted(set(filter(None,names))):
  f=root/name
  if not f.is_file() or f.is_symlink() or '.DS_Store' in name or '/.git/' in name:continue
  if name.startswith(('tmp/','.git/')):continue
  if '/' in name and not name.startswith(allow_prefix):continue
  if name.endswith(('.pem','.key','.p12','.pfx','.p8')) or Path(name).name=='config.xml':
   # Explicit tracked source fixtures/public signing key only. No local instances.
   tracked=subprocess.run(['git','ls-files','--error-unmatch','--',name],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
   if not tracked:continue
  if name.startswith('desktop/src-tauri/resources/'):continue
  files['source/'+name]=f.read_bytes()
 files['source/desktop/src-tauri/resources/.gitkeep']=b''
 files['windows/syncthing.exe']=args.windows_core.read_bytes()
 ca=args.ca.read_bytes()
 if b'PRIVATE KEY' in ca or b'BEGIN CERTIFICATE' not in ca:p.error('CA input is not a public certificate')
 files['trust/ca.pem']=ca
 files['WINDOWS-PROMPT.md']=(root/'docs/windows-tauri-handoff.md').read_bytes()
 files['build-windows.ps1']=(root/'script/cloud_windows_build.ps1').read_bytes()
 manifest={'format':1,'sourceBaseCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'includesUncommittedWorkspace':True,'caFileSHA256':hashlib.sha256(ca).hexdigest(),'files':{name:hashlib.sha256(data).hexdigest() for name,data in files.items()}}
 files['MANIFEST.json']=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
 args.output.parent.mkdir(parents=True,exist_ok=True)
 with zipfile.ZipFile(args.output,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
  for name,data in files.items():z.writestr('xun-cloud-handoff/'+name,data)
 digest=hashlib.sha256(args.output.read_bytes()).hexdigest()
 args.output.with_suffix(args.output.suffix+'.sha256').write_text(digest+'  '+args.output.name+'\n')
 print(json.dumps({'artifact':str(args.output),'sha256':digest,'files':len(files),'bytes':args.output.stat().st_size},indent=2))
if __name__=='__main__':main()
