"""Isolated SR-34 arbitration experiment: fake processes and pipes, no OS input.

This is deliberately not a production coordinator, authentication boundary, AX cancellation,
network protocol, or restart/recovery implementation.  Run with python3 directly.
"""
import multiprocessing as mp
from multiprocessing.connection import wait
import time
import unittest


def broker(control, ai, human):
    endpoints = {ai: 'ai', human: 'human'}
    active = None
    active_id = None
    pending = None
    spent = set()
    hold_until = 0
    now = 0
    uncertain = False
    audit = []
    alive = {ai, human}
    while True:
        for source in wait([control, *alive]):
            try:
                msg = source.recv()
            except EOFError:
                alive.discard(source)
                if source is ai and active == 'ai':
                    uncertain = True
                    active = None
                    active_id = None
                    audit.append('ai-uncertain')
                continue
            op = msg['op']
            if source is control:
                if op == 'stop':
                    return
                if op == 'advance':
                    now += msg['ms']
                if op == 'state':
                    control.send({'active': active, 'pending': pending, 'uncertain': uncertain,
                                  'hold_until': hold_until, 'now': now, 'audit': list(audit)})
                continue
            role = endpoints[source]
            if role == 'ai' and op == 'begin':
                request_id = msg['id']
                if request_id in spent:
                    source.send({'result': 'duplicate'})
                elif active is not None or pending is not None or uncertain or now < hold_until:
                    spent.add(request_id)
                    source.send({'result': 'refused'})
                else:
                    spent.add(request_id)
                    active = 'ai'
                    active_id = request_id
                    audit.append('ai-begin')
                    source.send({'result': 'granted'})
            elif role == 'ai' and op == 'finish' and active == 'ai' and msg['id'] == active_id:
                active = None
                active_id = None
                audit.append('ai-finish')
                source.send({'result': 'finished'})
                if pending is not None:
                    active, pending = 'human', None
                    audit.append('human-granted')
                    human.send({'result': 'granted'})
            elif role == 'human' and op == 'begin':
                if active == 'ai' or uncertain:
                    if pending is None:
                        pending = msg['id']
                        audit.append('human-pending')
                        source.send({'result': 'pending'})
                    else:
                        source.send({'result': 'not-admitted'})
                elif active is None:
                    active = 'human'
                    audit.append('human-granted')
                    source.send({'result': 'granted'})
                else:
                    source.send({'result': 'not-admitted'})
            elif role == 'human' and op == 'post' and active == 'human':
                # Fake effect only. The real payload remains held by the human-side actor until this acknowledgement.
                audit.append('human-post')
                hold_until = now + 10000
                active = None
                source.send({'result': 'posted'})
            else:
                source.send({'result': 'invalid'})


def fake_actor(role, control, link):
    held = None
    granted = False
    connected = True
    sends = 0
    posts = 0
    while True:
        sources = [control] + ([link] if connected else [])
        for source in wait(sources):
            try:
                msg = source.recv()
            except EOFError:
                if source is control:
                    return
                connected = False
                granted = False
                control.send({'event': 'broker-lost', 'held': held})
                continue
            if source is link:
                if msg['result'] == 'granted' and role == 'human':
                    granted = True
                if msg['result'] == 'posted':
                    held = None
                    granted = False
                    posts += 1
                control.send({'event': 'broker-response', **msg})
                continue
            op = msg['op']
            if op == 'stop':
                return
            if op == 'state':
                control.send({'held': held, 'granted': granted, 'connected': connected,
                              'sends': sends, 'posts': posts})
                continue
            if not connected:
                control.send({'event': 'local-refusal', 'held': held})
                continue
            if role == 'human' and op == 'begin':
                if held is not None:
                    control.send({'event': 'backpressure', 'held': held})
                    continue
                held = msg['id']
            if role == 'human' and op == 'post' and not granted:
                control.send({'event': 'local-refusal', 'held': held})
                continue
            link.send(msg)
            sends += 1
            control.send({'event': 'sent'})


class ArbitrationTests(unittest.TestCase):
    def setUp(self):
        self.ctx = mp.get_context('spawn')
        self.bc, broker_control = self.ctx.Pipe()
        self.ac, ai_control = self.ctx.Pipe()
        self.hc, human_control = self.ctx.Pipe()
        broker_ai, ai_link = self.ctx.Pipe()
        broker_human, human_link = self.ctx.Pipe()
        self.b = self.ctx.Process(target=broker, args=(broker_control, broker_ai, broker_human))
        self.a = self.ctx.Process(target=fake_actor, args=('ai', ai_control, ai_link))
        self.h = self.ctx.Process(target=fake_actor, args=('human', human_control, human_link))
        self.b.start(); self.a.start(); self.h.start()
        for end in (broker_control, ai_control, human_control, broker_ai, ai_link, broker_human, human_link):
            end.close()

    def recv(self, conn):
        self.assertTrue(conn.poll(5), 'isolated process did not respond')
        return conn.recv()

    def send(self, conn, op, **fields):
        conn.send({'op': op, **fields})
        self.assertEqual(self.recv(conn), {'event': 'sent'})
        return self.recv(conn)

    def state(self, conn):
        conn.send({'op': 'state'})
        return self.recv(conn)

    def tearDown(self):
        for conn in (self.ac, self.hc, self.bc):
            try:
                conn.send({'op': 'stop'})
            except (BrokenPipeError, EOFError, OSError):
                pass
        for proc in (self.a, self.h, self.b):
            proc.join(3)
            if proc.is_alive():
                proc.kill(); proc.join(3)
        for conn in (self.ac, self.hc, self.bc):
            conn.close()

    def test_pending_human_is_retained_and_no_timeout_releases_active_ai(self):
        self.assertEqual(self.send(self.ac, 'begin', id='ai-1')['result'], 'granted')
        self.assertEqual(self.send(self.hc, 'begin', id='human-1')['result'], 'pending')
        self.assertEqual(self.state(self.hc)['held'], 'human-1')
        self.bc.send({'op': 'advance', 'ms': 3_600_000})
        self.assertEqual(self.send(self.ac, 'begin', id='ai-2')['result'], 'refused')
        self.hc.send({'op': 'begin', 'id': 'human-2'})
        self.assertEqual(self.recv(self.hc), {'event': 'backpressure', 'held': 'human-1'})
        self.assertEqual(self.send(self.ac, 'finish', id='ai-1')['result'], 'finished')
        self.assertEqual(self.recv(self.hc)['result'], 'granted')
        self.assertEqual(self.send(self.hc, 'post')['result'], 'posted')
        self.assertIsNone(self.state(self.hc)['held'])
        self.assertEqual(self.send(self.ac, 'begin', id='ai-3')['result'], 'refused')
        self.bc.send({'op': 'advance', 'ms': 10_000})
        self.assertEqual(self.send(self.ac, 'begin', id='ai-3')['result'], 'duplicate')
        self.assertEqual(self.send(self.ac, 'begin', id='ai-4')['result'], 'granted')
        self.assertEqual(self.state(self.bc)['audit'], ['ai-begin', 'human-pending', 'ai-finish',
                                                       'human-granted', 'human-post', 'ai-begin'])

    def test_human_first_blocks_ai_until_hold_expires(self):
        self.assertEqual(self.send(self.hc, 'begin', id='human-first')['result'], 'granted')
        self.assertEqual(self.send(self.ac, 'begin', id='ai-rejected')['result'], 'refused')
        self.assertEqual(self.send(self.hc, 'post')['result'], 'posted')
        self.bc.send({'op': 'advance', 'ms': 9_999})
        self.assertEqual(self.send(self.ac, 'begin', id='ai-still-rejected')['result'], 'refused')
        self.bc.send({'op': 'advance', 'ms': 1})
        self.assertEqual(self.send(self.ac, 'begin', id='ai-after')['result'], 'granted')

    def test_dead_ai_never_implies_safe_human_dispatch(self):
        self.assertEqual(self.send(self.ac, 'begin', id='ai-1')['result'], 'granted')
        self.assertEqual(self.send(self.hc, 'begin', id='human-1')['result'], 'pending')
        self.a.kill(); self.a.join(3)
        deadline = time.monotonic() + 5
        while True:
            state = self.state(self.bc)
            if state['uncertain']:
                break
            self.assertLess(time.monotonic(), deadline, 'broker failed to detect actor exit')
            time.sleep(0.01)
        self.assertEqual(state['pending'], 'human-1')
        self.assertIsNone(state['active'])
        self.hc.send({'op': 'post'})
        self.assertEqual(self.recv(self.hc), {'event': 'local-refusal', 'held': 'human-1'})
        self.assertEqual(self.state(self.hc)['posts'], 0)

    def test_dead_broker_keeps_human_request_locally_without_replay(self):
        self.assertEqual(self.send(self.ac, 'begin', id='ai-1')['result'], 'granted')
        self.assertEqual(self.send(self.hc, 'begin', id='human-1')['result'], 'pending')
        before = self.state(self.hc)['sends']
        self.b.kill(); self.b.join(3)
        self.assertEqual(self.recv(self.hc), {'event': 'broker-lost', 'held': 'human-1'})
        state = self.state(self.hc)
        self.assertEqual(state['held'], 'human-1')
        self.assertFalse(state['connected'])
        self.assertEqual(state['sends'], before)
        self.hc.send({'op': 'post'})
        self.assertEqual(self.recv(self.hc), {'event': 'local-refusal', 'held': 'human-1'})
        self.assertEqual(self.state(self.hc)['posts'], 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
