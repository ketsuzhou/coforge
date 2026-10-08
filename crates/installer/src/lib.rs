//! The CoForge installer (`coforge-installer`): the separately released native binary that
//! owns every change to a CoForge Computer installation.
//!
//! So far it carries the verified-download plumbing, the machine mutation lock, installation
//! paths, the release version rule, the active version switch, the contract types shared with the
//! product, and everything that puts a release version into `versions/` (feed client, manifest
//! rules, version store), plus control of the running Computer: the OS service manager
//! (`service`) and the product's processes (`processes`). The install transaction around them
//! is not here yet.

pub mod active;
pub mod clock;
pub mod contract;
pub mod digest;
pub mod feed;
pub mod fetch;
mod idle_timeout;
pub mod lock;
pub mod manifest;
pub mod paths;
pub mod prepare;
mod private_fs;
pub mod processes;
pub mod service;
pub mod store;
pub mod update_error;
pub mod version;

#[cfg(test)]
mod test_support;
