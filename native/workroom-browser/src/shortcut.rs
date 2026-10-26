/// Return only the trusted browser chords. Caps Lock changes ASCII case without
/// changing the chord; an IME may instead leave the character empty/non-ASCII.
pub(crate) fn canonical_shortcut(character: u16, native_key_code: i32, exact_command: bool) -> Option<char> {
    if !exact_command {
        return None;
    }
    if let Some(key) = char::from_u32(u32::from(character)).map(|key| key.to_ascii_lowercase()) {
        if matches!(key, 'l' | 'r' | '[' | ']' | 't' | '1'..='6') {
            return Some(key);
        }
    }
    // macOS kVK_ANSI_L. Never override a layout's different ASCII character
    // (for example Dvorak), or turn another physical key into a browser chord.
    if (character == 0 || character > 127) && native_key_code == 37 {
        return Some('l');
    }
    None
}

#[cfg(test)]
mod tests {
    use super::canonical_shortcut;

    #[test]
    fn canonicalizes_allowed_characters_before_considering_the_physical_key() {
        for key in ['l', 'r', 't', '[', ']', '1', '2', '3', '4', '5', '6'] {
            assert_eq!(canonical_shortcut(key as u16, 0, true), Some(key));
            assert_eq!(canonical_shortcut(key.to_ascii_uppercase() as u16, 37, true), Some(key));
        }
    }

    #[test]
    fn only_missing_or_ime_characters_on_the_mac_l_key_fall_back_to_l() {
        for character in [0, 'ㅣ' as u16, '한' as u16, 'ㄱ' as u16, 0xd800, 0xffff] {
            assert_eq!(canonical_shortcut(character, 37, true), Some('l'));
            for native_key_code in [0, 12, 15, 36, 38, -1] {
                assert_eq!(canonical_shortcut(character, native_key_code, true), None);
            }
        }
    }

    #[test]
    fn different_ascii_layout_characters_never_use_the_hardware_fallback() {
        for character in 1..=127 {
            let key = char::from_u32(u32::from(character)).unwrap().to_ascii_lowercase();
            if !matches!(key, 'l' | 'r' | '[' | ']' | 't' | '1'..='6') {
                assert_eq!(canonical_shortcut(character, 37, true), None, "ASCII {character}");
            }
        }
    }

    #[test]
    fn ordinary_input_and_non_exact_command_chords_never_map() {
        for character in [0, 'l' as u16, 'L' as u16, 'r' as u16, 't' as u16, '[' as u16, '1' as u16, 'ㅣ' as u16] {
            assert_eq!(canonical_shortcut(character, 37, false), None);
        }
    }
}
