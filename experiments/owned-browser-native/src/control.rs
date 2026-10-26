
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(not(atz_control_standalone), derive(serde::Serialize), serde(rename_all = "kebab-case"))]
pub enum Owner { Agent, Taking, Human, Observing }

/// Single writer; only the host owns this state. Hide/show does not change ownership.
#[derive(Debug)]
#[cfg_attr(not(atz_control_standalone), derive(serde::Serialize))]
pub struct Control { pub owner: Owner, pub epoch: u64, pub observation: Option<u64>, pub hidden: bool }
impl Default for Control {
    fn default() -> Self { Self { owner: Owner::Observing, epoch: 1, observation: None, hidden: false } }
}
impl Control {
    pub fn take(&mut self) { self.epoch += 1; self.owner = Owner::Taking; self.observation = None; }
    pub fn confirm_human(&mut self, epoch: u64) -> bool {
        if self.owner != Owner::Taking || self.epoch != epoch { return false; }
        self.owner = Owner::Human; true
    }
    pub fn resume(&mut self) -> Result<u64, &'static str> {
        if self.owner != Owner::Human { return Err("take control before returning it"); }
        self.epoch += 1; self.owner = Owner::Observing; self.observation = None;
        Ok(self.epoch)
    }
    pub fn observed(&mut self, epoch: u64) -> bool {
        if self.owner != Owner::Observing || self.epoch != epoch { return false; }
        self.observation = Some(epoch); self.owner = Owner::Agent; true
    }
    pub fn check_agent(&self, epoch: u64) -> Result<(), &'static str> {
        if self.owner != Owner::Agent || self.epoch != epoch || self.observation != Some(epoch) {
            return Err("stale command or human control: observe again");
        }
        Ok(())
    }
    pub fn navigating(&mut self) {
        self.epoch += 1; self.observation = None;
        if self.owner != Owner::Human { self.owner = Owner::Observing; }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn takeover_fences_old_commands_and_return_needs_a_fresh_observation() {
        let mut c = Control::default();
        assert!(c.observed(1)); assert!(c.check_agent(1).is_ok());
        c.take(); assert!(c.check_agent(1).is_err());
        assert!(c.resume().is_err()); assert!(!c.confirm_human(1)); assert!(c.confirm_human(c.epoch));
        let epoch = c.resume().unwrap();
        assert!(c.check_agent(epoch).is_err()); assert!(!c.observed(1));
        assert!(c.observed(epoch)); assert!(c.check_agent(epoch).is_ok()); assert!(c.check_agent(1).is_err());
    }
    #[test]
    fn late_observation_cannot_reclaim_human_control() {
        let mut c = Control::default(); c.take();
        assert!(!c.observed(1)); assert!(!c.observed(c.epoch));
        assert!(c.confirm_human(c.epoch)); assert!(!c.observed(c.epoch)); assert_eq!(c.owner, Owner::Human);
    }
    #[test]
    fn hiding_preserves_control_and_navigation_invalidates_observation() {
        let mut c = Control::default(); c.observed(1); c.hidden = true; c.hidden = false;
        assert!(c.check_agent(1).is_ok()); c.navigating();
        assert!(c.check_agent(1).is_err()); assert_eq!(c.owner, Owner::Observing);
    }
}
