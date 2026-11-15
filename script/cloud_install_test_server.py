#!/usr/bin/env python3
"""Provision a new isolated Mac LAN test service; never edit an existing instance."""
import json,os,plistlib,secrets,shutil,socket,subprocess,xml.etree.ElementTree as ET
from pathlib import Path
import argparse

def main():
 p=argparse.ArgumentParser();p.add_argument('--binary',type=Path,required=True);p.add_argument('--ip',required=True);args=p.parse_args()
 import ipaddress;ipaddress.IPv4Address(args.ip)
 home=Path.home();base=home/'Library/Application Support/XunCloud-TestServer';cfg=base/'config';pki=base/'pki';user_root=home/'XunCloud-TestServer-Data'
 plist=home/'Library/LaunchAgents/com.xun.cloud-test-server.plist'
 if cfg.exists() or plist.exists() or user_root.exists():p.error('Test service/data already exists; refusing overwrite')
 if not (pki/'server.pem').is_file():p.error('Generate test PKI first')
 for host,port in [('127.0.0.1',18385),(args.ip,18443),(args.ip,22110)]:
  with socket.socket() as s:s.bind((host,port))
 os.umask(0o077);cfg.mkdir(parents=True,mode=0o700);user_root.mkdir(mode=0o700);(base/'bin').mkdir(mode=0o700)
 binary=base/'bin/syncthing';shutil.copy2(args.binary,binary);binary.chmod(0o700)
 password=secrets.token_urlsafe(24);cloud_password=secrets.token_urlsafe(24)
 env={k:v for k,v in os.environ.items() if not k.startswith(('ST','XUNCLOUD_'))}
 def core(*cmd,input=None):return subprocess.run([str(binary),'--home',str(cfg),*cmd],input=input,text=True,env=env,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 core('generate','--no-port-probing','--gui-user','test-admin','--gui-password','-',input=password+'\n')
 tree=ET.parse(cfg/'config.xml');root=tree.getroot();gui=root.find('gui');gui.set('tls','true');gui.find('address').text='127.0.0.1:18385'
 opts=root.find('options')
 for e in list(opts.findall('listenAddress')):opts.remove(e)
 ET.SubElement(opts,'listenAddress').text='tcp://'+args.ip+':22110'
 for k,v in {'globalAnnounceEnabled':'false','localAnnounceEnabled':'false','relaysEnabled':'false','natEnabled':'false','startBrowser':'false','crashReportingEnabled':'false','autoUpgradeIntervalH':'0','urAccepted':'-1'}.items():
  e=opts.find(k)
  if e is None:e=ET.SubElement(opts,k)
  e.text=v
 tree.write(cfg/'config.xml',encoding='utf-8')
 shutil.copy2(pki/'server.pem',cfg/'https-cert.pem');shutil.copy2(pki/'server-key.pem',cfg/'https-key.pem')
 core('cloud','add-user','testuser',input=cloud_password+'\n')
 creds={'username':'testuser','password':cloud_password,'server':args.ip+':18443'}
 (base/'test-account.json').write_text(json.dumps(creds,indent=2)+'\n');(base/'test-account.json').chmod(0o600)
 (base/'admin.json').write_text(json.dumps({'username':'test-admin','password':password})+'\n');(base/'admin.json').chmod(0o600)
 entry={'Label':'com.xun.cloud-test-server','ProgramArguments':[str(binary),'--home',str(cfg),'serve','--no-browser','--no-restart','--no-upgrade','--cloud-listen',args.ip+':18443','--cloud-root',str(user_root),'--cloud-cert',str(pki/'server.pem'),'--cloud-key',str(pki/'server-key.pem'),'--cloud-sync-port','22110'],'EnvironmentVariables':{'STMONITORED':'1'},'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':15,'StandardOutPath':str(base/'server.log'),'StandardErrorPath':str(base/'server-error.log')}
 plist.write_bytes(plistlib.dumps(entry));plist.chmod(0o600)
 print('Prepared isolated service:',plist);print('LAN enrollment:',creds['server']);print('Credentials are local-only:',base/'test-account.json')
if __name__=='__main__':main()
