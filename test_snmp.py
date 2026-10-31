import asyncio

from pysnmp.hlapi.v3arch.asyncio import *

async def main():
    engine = SnmpEngine()

    target = await UdpTransportTarget.create(
        ("10.10.1.1", 161),
        timeout=3,
        retries=0
    )

    result = await get_cmd(
        engine,
        CommunityData("public", mpModel=1),
        target,
        ContextData(),
        ObjectType(ObjectIdentity("1.3.6.1.2.1.1.1.0"))
    )

    print("SNMP result:", result)
    engine.close_dispatcher()

asyncio.run(main())
