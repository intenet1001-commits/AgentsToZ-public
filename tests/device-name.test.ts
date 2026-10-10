import {afterEach,describe,expect,test} from 'bun:test';
import {DEFAULT_DEVICE_NAME,DeviceRenameError,describeRenameResult,deviceHostName,renameThisDevice,validateDeviceName} from '../src/deviceName';
import {connectionDisplayName,internetConnectionLabelKey,lanConnectionLabelKey,readConnectionLabel,writeConnectionLabel} from '../src/RemoteConnectionLabel';

const apiSource=await Bun.file(new URL('../api-server.ts',import.meta.url)).text();
const appSource=await Bun.file(new URL('../src/App.tsx',import.meta.url)).text();

const originalLocalStorage=globalThis.localStorage;
afterEach(()=>{Object.defineProperty(globalThis,'localStorage',{configurable:true,value:originalLocalStorage});});

function storageFixture(seed:Record<string,string>={}) {
  const values=new Map(Object.entries(seed));
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
    getItem:(key:string)=>values.get(key)??null,
    setItem:(key:string,value:string)=>{values.set(key,value);},
    removeItem:(key:string)=>{values.delete(key);},
  }});
  return values;
}

describe('device display names',()=>{
  test('normalizes safe names and rejects empty, overlong, control, and bidi-spoofing input',()=>{
    expect(validateDeviceName('  Cafe\u0301 Mac  ')).toEqual({ok:true,value:'Café Mac'});
    for(const value of ['', ' '.repeat(4), 'a'.repeat(41), 'line\nbreak', 'Mac\u202ebook'])expect(validateDeviceName(value).ok).toBe(false);
    expect(validateDeviceName('😀'.repeat(40))).toEqual({ok:true,value:'😀'.repeat(40)});
  });

  test('uses only a validated portal device name for LAN and internet host labels',()=>{
    expect(deviceHostName({deviceName:'  회사 MacBook  '})).toBe('회사 MacBook');
    expect(deviceHostName({deviceName:'Mac\u202ebook'})).toBe(DEFAULT_DEVICE_NAME);
    expect(deviceHostName({deviceName:'a'.repeat(41)})).toBe(DEFAULT_DEVICE_NAME);
    expect(deviceHostName(null)).toBe(DEFAULT_DEVICE_NAME);
  });

  test('wires the same live device name into LAN QR, internet QR, and phone links',()=>{
    expect(apiSource).toContain('hostName: remoteControlDeviceHostName()');
    expect(apiSource.match(/hostName: remoteControlDeviceHostName\(\)/g)).toHaveLength(2);
    expect(apiSource).toContain('remoteControlLanServer?.setHostName(remoteControlDeviceHostName())');
    expect(apiSource).toContain('remoteControlInternetAgent?.setHostName(remoteControlDeviceHostName())');
    expect(appSource).toContain("const [portalDeviceName, setPortalDeviceName] = useState('')");
    expect(appSource).toContain('hostLabel={portalDeviceName || null}');
  });

  test('saves the exact local device before propagation and preserves unrelated portal fields',async()=>{
    let portal:Record<string,unknown>={deviceId:'device-one',deviceName:'Old',items:[{id:'keep'}],supabaseUrl:'https://fixture.invalid'};
    const events:string[]=[];
    const result=await renameThisDevice({deviceId:'device-one',name:'  새 Mac  '},{
      loadPortal:async()=>({...portal}),
      savePortal:async next=>{events.push('local');portal={...next};},
      notify:change=>events.push('notify:'+change.deviceName),
      updateRemoteName:async(saved,id,name)=>{events.push('remote');expect(saved).toEqual(portal);expect([id,name]).toEqual(['device-one','새 Mac']);return 'updated';},
    });
    expect(events).toEqual(['local','notify:새 Mac','remote']);
    expect(portal).toMatchObject({deviceId:'device-one',deviceName:'새 Mac',items:[{id:'keep'}]});
    expect(result).toEqual({deviceName:'새 Mac',changed:true,remote:'updated'});
  });

  test('fails closed on identity or local-write mismatch without notifying or touching remote',async()=>{
    let effects=0;
    await expect(renameThisDevice({deviceId:'screen-device',name:'New'},{loadPortal:async()=>({deviceId:'disk-device'}),savePortal:async()=>{effects++;},notify:()=>{effects++;},updateRemoteName:async()=>{effects++;return 'updated';}})).rejects.toBeInstanceOf(DeviceRenameError);
    await expect(renameThisDevice({deviceId:'device-one',name:'New'},{loadPortal:async()=>({deviceId:'device-one'}),savePortal:async()=>{throw new Error('disk full');},notify:()=>{effects++;},updateRemoteName:async()=>{effects++;return 'updated';}})).rejects.toThrow('disk full');
    expect(effects).toBe(0);
  });

  test('keeps a successful local rename when remote propagation fails and explains the retry',async()=>{
    let saved:Record<string,unknown>|null=null;
    const result=await renameThisDevice({deviceId:'device-one',name:'Offline Mac'},{loadPortal:async()=>({deviceId:'device-one'}),savePortal:async next=>{saved=next;},notify:()=>{},updateRemoteName:async()=>{throw new Error('offline');}});
    expect(saved).toMatchObject({deviceName:'Offline Mac'});
    expect(result.remote).toBe('failed');
    expect(describeRenameResult(result)).toMatchObject({kind:'error'});
    expect(describeRenameResult(result).message).toContain('다음 올리기(Push)');
  });

  test('stores connection aliases under stable transport-specific keys and ignores unsafe legacy values',()=>{
    const internet=internetConnectionLabelKey('session-1234'),lan=lanConnectionLabelKey('2026-09-27T00:00:00Z');
    const values=storageFixture({[internet]:'Legacy\u202ePhone'});
    expect(internet).not.toBe(lan);expect(readConnectionLabel(internet)).toBe('');
    expect(writeConnectionLabel(lan,' iPhone 17 ')).toBe('iPhone 17');
    expect(values.get(lan)).toBe('iPhone 17');
    expect(connectionDisplayName(lan,'AgentsToZ 앱')).toBe('iPhone 17');
    expect(()=>writeConnectionLabel(lan,'bad\nname')).toThrow('제어 문자');
  });
});
