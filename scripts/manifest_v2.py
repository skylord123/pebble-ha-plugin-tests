#!/usr/bin/env python3
"""
Copy a pbw, marking its appinfo.json "manifestVersion": 2.

The Pebble app only lets an app read plugins' sources and call their
actions when its appinfo.json says manifestVersion 2, and `pebble build`
does not write it. The permissions come from package.json's `pebble`
block, which the SDK copies over as they are.

    manifest_v2.py <built.pbw> <out.pbw>
"""
import json
import sys
import zipfile


def main(source, target):
    with zipfile.ZipFile(source) as z:
        entries = [(info, z.read(info)) for info in z.infolist()]
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for info, data in entries:
            if info.filename == "appinfo.json":
                appinfo = json.loads(data)
                appinfo["manifestVersion"] = 2
                if not appinfo.get("usesPermissions"):
                    sys.exit(source + ": no usesPermissions in appinfo.json; is the SDK too old?")
                data = json.dumps(appinfo, indent=2).encode("utf-8")
                print("%s: %s %s, permissions %s" % (target, appinfo["longName"], appinfo["versionLabel"],
                                                   json.dumps(appinfo["usesPermissions"])))
            z.writestr(info, data)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
