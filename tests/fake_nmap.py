#!/usr/bin/env python3
"""A stand-in for nmap in the scan tests: it never sends a packet. It answers
from JSON files in $FAKE_NMAP_DIR and logs every call to calls.log there.

  up.json        ["10.1.0.5", ...]       addresses a ping sweep (-sn) finds
  discovery.json {"fail": "message"}     make the ping sweep fail
  <ip>.json      {"ports": [22, 80], "fail": "msg", "timeout": true, "sleep": 2}
"""
import ipaddress
import json
import os
import sys
import time

D = os.environ["FAKE_NMAP_DIR"]
args = sys.argv[1:]
with open(os.path.join(D, "calls.log"), "a") as f:
    f.write(json.dumps(args) + "\n")


def load(name, default):
    try:
        with open(os.path.join(D, name)) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


HEAD = ('<?xml version="1.0"?><nmaprun scanner="nmap" args="nmap" start="1" version="7.94" xmloutputversion="1.05">'
        '<scaninfo type="syn" protocol="tcp" numservices="1000" services="1-1000"/>')
TAIL = ('<runstats><finished time="2" timestr="x" elapsed="0.1" summary="" exit="success"/>'
        '<hosts up="1" down="0" total="1"/></runstats></nmaprun>')


def host(ip, inner="", attrs="", info=None):
    """info (from <ip>.json): name, mac, vendor, os — what the network reports."""
    info = info or {}
    mac = (f'<address addr="{info["mac"]}" addrtype="mac"' + (f' vendor="{info["vendor"]}"' if info.get("vendor") else "") + "/>"
           if info.get("mac") else "")
    names = (f'<hostnames><hostname name="{info["name"]}" type="PTR"/></hostnames>' if info.get("name") else "<hostnames/>")
    os_ = (f'<os><osmatch name="{info["os"]}" accuracy="95" line="1"><osclass type="general purpose" vendor="Demo" '
           f'osfamily="Linux" osgen="5.X" accuracy="95"/></osmatch></os>' if info.get("os") else "")
    return (f'<host{attrs}><status state="up" reason="syn-ack" reason_ttl="0"/>'
            f'<address addr="{ip}" addrtype="ipv4"/>{mac}{names}{inner}{os_}</host>')


targets = [a for a in args if a[:1].isdigit()]
if args == ["-V"]:                        # python-nmap checks the version first
    print("Nmap version 7.94 ( https://nmap.org )\nPlatform: x86_64-pc-linux-gnu")
elif "-sn" in args:
    d = load("discovery.json", {})
    if d.get("fail"):
        sys.stderr.write(d["fail"] + "\n")
        sys.exit(1)
    print(HEAD + "".join(host(ip, info=load(f"{ip}.json", {})) for ip in load("up.json", [])) + TAIL)
elif "-sL" in args:
    ips = [str(a) for t in targets for a in ipaddress.ip_network(t, strict=False)]
    print(HEAD + "".join(f'<host><status state="unknown" reason="user-set"/><address addr="{ip}" addrtype="ipv4"/>'
                         f'<hostnames/></host>' for ip in ips) + TAIL)
else:
    ip = targets[-1]
    h = load(f"{ip}.json", {})
    if h.get("sleep"):
        time.sleep(h["sleep"])
    if h.get("fail"):
        sys.stderr.write("Starting Nmap 7.94\n" + h["fail"] + "\n")
        sys.exit(255)
    if h.get("timeout"):
        print(HEAD + host(ip, attrs=' starttime="1" endtime="2" timedout="true"') + TAIL)
    elif h.get("ports"):
        ports = "".join(f'<port protocol="tcp" portid="{p}"><state state="open" reason="syn-ack" reason_ttl="0"/>'
                        f'<service name="demo{p}" method="table" conf="3"/></port>' for p in h["ports"])
        print(HEAD + host(ip, f"<ports>{ports}</ports>", info=h) + TAIL)
    else:
        print(HEAD + TAIL)                # --open and nothing open: no <host> at all
