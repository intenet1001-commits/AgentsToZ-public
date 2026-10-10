import {expect,test} from 'bun:test';
import {normalizePortalLoginCode,normalizePortalLoginEmail,portalEmailCodeError,requestPortalEmailCode,verifyPortalEmailCode,type PortalEmailCodeClient} from '../src/portalEmailCodeAuth';

function client(responses:{otp?:any;verify?:any}={}){
  const calls:any[]=[];
  const c:PortalEmailCodeClient={auth:{
    signInWithOtp:async a=>{calls.push(['otp',a]);return {error:responses.otp??null}},
    verifyOtp:async a=>{calls.push(['verify',a]);return {error:responses.verify??null}},
  }};
  return {c,calls};
}

test('normalizes email and 6–8 digit codes', () => {
  expect(normalizePortalLoginEmail('  Me@Example.COM ')).toBe('me@example.com');
  expect(normalizePortalLoginEmail('not-an-email')).toBeNull();
  expect(normalizePortalLoginCode('1234 5678')).toBe('12345678');
  expect(normalizePortalLoginCode('123456')).toBe('123456');
  expect(normalizePortalLoginCode('12345')).toBeNull();
  expect(normalizePortalLoginCode('12a456')).toBeNull();
});

test('never creates an account from a code request', async () => {
  const {c,calls}=client();
  expect(await requestPortalEmailCode(c,'Me@Example.com')).toBe('me@example.com');
  expect(calls).toEqual([['otp',{email:'me@example.com',options:{shouldCreateUser:false}}]]);
});

test('verifies with the email type and the normalized code', async () => {
  const {c,calls}=client();
  await verifyPortalEmailCode(c,'me@example.com','1234 5678');
  expect(calls).toEqual([['verify',{email:'me@example.com',token:'12345678',type:'email'}]]);
});

test('rejects bad input before any request', async () => {
  const {c,calls}=client();
  await expect(requestPortalEmailCode(c,'nope')).rejects.toMatchObject({kind:'invalid-input'});
  await expect(verifyPortalEmailCode(c,'me@example.com','12')).rejects.toMatchObject({kind:'invalid-input'});
  expect(calls).toEqual([]);
});

test('explains each failure by its cause', async () => {
  expect(portalEmailCodeError({status:429,code:'over_email_send_rate_limit',message:'email rate limit exceeded'}).kind).toBe('rate-limited');
  expect(portalEmailCodeError({code:'otp_disabled',message:'Signups not allowed for otp'}).kind).toBe('no-account');
  expect(portalEmailCodeError({code:'otp_expired',message:'Token has expired or is invalid'}).kind).toBe('invalid-code');
  expect(portalEmailCodeError({message:'boom'}).kind).toBe('failed');
  const {c}=client({otp:{status:429,message:'email rate limit exceeded'}});
  await expect(requestPortalEmailCode(c,'me@example.com')).rejects.toMatchObject({kind:'rate-limited'});
});
