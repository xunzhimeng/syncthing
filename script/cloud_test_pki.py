#!/usr/bin/env python3
"""Generate app-scoped development CA + server cert. Never edits system trust.
Output must be new. Keep CA/server keys private; only ca.pem may be distributed.
"""
import argparse
import ipaddress
import json
from pathlib import Path
import re
import subprocess
import os

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--host',action='append',required=True)
    args=p.parse_args()
    hosts=[]
    for host in args.host:
        try:
            hosts.append(('IP',str(ipaddress.ip_address(host))))
        except ValueError:
            if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]{0,250}[A-Za-z0-9])?',host):p.error('Invalid hostname')
            hosts.append(('DNS',host))
    if args.output.exists():p.error('Output exists; never overwrite live keys or certificates')
    os.umask(0o077)
    out=args.output.resolve();out.mkdir(parents=True,mode=0o700)
    ca='[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=XunCloud Test App CA\n[ext]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n'
    leaf='[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=XunCloud Test Server\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName='+','.join(k+':'+v for k,v in hosts)+'\n'
    (out/'ca.cnf').write_text(ca);(out/'server.cnf').write_text(leaf)
    def run(*cmd):subprocess.run(['openssl',*cmd],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    run('req','-x509','-newkey','rsa:3072','-nodes','-days','730','-config',str(out/'ca.cnf'),'-keyout',str(out/'ca-key.pem'),'-out',str(out/'ca.pem'))
    run('req','-new','-newkey','rsa:2048','-nodes','-config',str(out/'server.cnf'),'-keyout',str(out/'server-key.pem'),'-out',str(out/'server.csr'))
    run('x509','-req','-in',str(out/'server.csr'),'-CA',str(out/'ca.pem'),'-CAkey',str(out/'ca-key.pem'),'-CAcreateserial','-days','365','-sha256','-extfile',str(out/'server.cnf'),'-extensions','ext','-out',str(out/'server.pem'))
    import hashlib
    public={'hosts':[v for _,v in hosts],'caFileSHA256':hashlib.sha256((out/'ca.pem').read_bytes()).hexdigest()}
    (out/'public-info.json').write_text(json.dumps(public,indent=2)+'\n')
    print(json.dumps(public,indent=2))
if __name__=='__main__':main()
