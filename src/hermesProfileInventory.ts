export function isInstalledHermesProfile(input: {
  configYamlPresent: boolean;
  envPresent: boolean;
  soulPresent: boolean;
}): boolean {
  return input.configYamlPresent || (input.envPresent && input.soulPresent);
}
