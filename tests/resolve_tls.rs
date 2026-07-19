use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rcgen::{
    BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose,
};
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wreq::tls::trust::CertStore;

#[derive(Debug)]
struct SniRecorder {
    certified_key: Arc<CertifiedKey>,
    seen: Arc<Mutex<Option<String>>>,
}

impl ResolvesServerCert for SniRecorder {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        *self.seen.lock().expect("SNI recorder lock") = hello.server_name().map(str::to_owned);
        Some(self.certified_key.clone())
    }
}

#[tokio::test]
async fn resolve_pins_socket_while_sni_and_cert_stay_on_hostname() {
    // Create a private CA and a leaf whose only SAN is DNS:pinned.test. There
    // is deliberately no IP SAN: a successful handshake after connecting to
    // 127.0.0.1 proves certificate validation still used the URL hostname.
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).expect("CA params");
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
    ];
    let ca_key = KeyPair::generate().expect("CA key");
    let ca = ca_params.self_signed(&ca_key).expect("CA certificate");

    let mut leaf_params =
        CertificateParams::new(vec!["pinned.test".to_string()]).expect("leaf params");
    leaf_params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let leaf_key = KeyPair::generate().expect("leaf key");
    let leaf = leaf_params
        .signed_by(&leaf_key, &ca, &ca_key)
        .expect("CA-signed leaf");

    let private_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));
    let signing_key =
        rustls::crypto::ring::sign::any_supported_type(&private_key).expect("supported leaf key");
    let certified_key = Arc::new(CertifiedKey::new(vec![leaf.der().clone()], signing_key));
    let sni_seen = Arc::new(Mutex::new(None));
    let server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(SniRecorder {
            certified_key,
            seen: sni_seen.clone(),
        }));
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config));

    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind TLS server");
    let server_addr = listener.local_addr().expect("TLS server address");
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.expect("accept pinned client");
        let mut tls = acceptor.accept(tcp).await.expect("TLS handshake");
        let mut request = [0_u8; 4096];
        let _ = tls.read(&mut request).await.expect("read HTTP request");
        tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .expect("write HTTP response");
        tls.shutdown().await.expect("close TLS response");
    });

    let cert_store = CertStore::builder()
        .add_der_cert(ca.der())
        .build()
        .expect("test CA store");
    let client = wreq::Client::builder()
        .tls_cert_store(cert_store.clone())
        .resolve_to_addrs(
            "pinned.test",
            [SocketAddr::new(
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                server_addr.port(),
            )],
        )
        .http1_only()
        .build()
        .expect("pinned wreq client");

    let response = client
        .get(format!("https://pinned.test:{}/", server_addr.port()))
        .send()
        .await
        .expect("pin should connect while the hostname certificate validates");
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().await.expect("response body"), "ok");
    server.await.expect("TLS server task");
    assert_eq!(
        sni_seen.lock().expect("SNI recorder lock").as_deref(),
        Some("pinned.test")
    );

    // Negative control: keep the hostname URL and port but pin its socket to a
    // different loopback address where no server is listening.
    let wrong_ip_client = wreq::Client::builder()
        .tls_cert_store(cert_store)
        .resolve_to_addrs(
            "pinned.test",
            [SocketAddr::new(
                IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)),
                server_addr.port(),
            )],
        )
        .http1_only()
        .timeout(Duration::from_secs(1))
        .build()
        .expect("wrong-IP wreq client");
    assert!(
        wrong_ip_client
            .get(format!("https://pinned.test:{}/", server_addr.port()))
            .send()
            .await
            .is_err(),
        "pinning to a non-listening IP must fail to connect"
    );
}
