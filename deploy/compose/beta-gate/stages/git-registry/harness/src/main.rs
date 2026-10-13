use std::{env, fs, time::Duration};

use nuriteo_server::{
    config::{SystemEnvironment, SystemFileReader},
    database::{DatabasePool, DatabasePoolConfig, DatabaseTlsConfig},
    integration::{IntegrationRepository, MasterKeyring},
    registry_gateway::RegistryGatewayService,
};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let command = required("NURITEO_GATE_HARNESS_COMMAND")?;
    let database_url = read_value(
        "NURITEO_GATE_DATABASE_URL",
        "NURITEO_GATE_DATABASE_URL_FILE",
    )?;
    let database_ca = fs::read(required("NURITEO_GATE_DATABASE_CA_FILE")?)?;
    let tls = DatabaseTlsConfig::verify_full(None, Some(database_ca), None)?;
    let pool = DatabasePool::connect(DatabasePoolConfig::new(
        database_url,
        0,
        2,
        Duration::from_secs(10),
        Duration::from_secs(10),
        tls,
    )?)
    .await?;
    let keyring = MasterKeyring::load(&SystemEnvironment, &SystemFileReader)?;
    let repository = IntegrationRepository::new(pool.clone(), keyring);
    match command.as_str() {
        "registry-fetch" => {
            let package = required("NURITEO_GATE_REGISTRY_PACKAGE")?;
            let gateway = RegistryGatewayService::new(repository);
            let payload = gateway.fetch_metadata(&package).await?;
            fs::write(
                required("NURITEO_GATE_REGISTRY_METADATA_FILE")?,
                &payload.body,
            )?;
            println!(
                "{}",
                json!({"connectionId": payload.connection_id.to_string(), "metadataBytes": payload.body.len()})
            );
        }
        "registry-expect-no-fallback" => {
            let package = required("NURITEO_GATE_REGISTRY_PACKAGE")?;
            let gateway = RegistryGatewayService::new(repository);
            if gateway.fetch_metadata(&package).await.is_ok() {
                return Err("disabled exact scope unexpectedly fell back".into());
            }
            println!("{}", json!({"noFallback": true}));
        }
        _ => return Err(format!("unknown command {command}").into()),
    }
    pool.close(Duration::from_secs(5)).await?;
    Ok(())
}

fn required(name: &str) -> Result<String, Box<dyn std::error::Error>> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} is required").into())
}

fn read_value(value_name: &str, file_name: &str) -> Result<String, Box<dyn std::error::Error>> {
    if let Ok(value) = env::var(value_name) {
        if !value.trim().is_empty() {
            return Ok(value);
        }
    }
    Ok(fs::read_to_string(required(file_name)?)?.trim().to_owned())
}
