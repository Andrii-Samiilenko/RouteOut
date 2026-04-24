import asyncio
import websockets

async def test_ws():
    try:
        async with websockets.connect('ws://localhost:8000/ws') as ws:
            print("Connected!")
            msg = await ws.recv()
            print(f"Received: {msg[:100]}...")
    except Exception as e:
        print(f"Error: {e}")

asyncio.run(test_ws())