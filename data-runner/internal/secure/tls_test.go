package secure

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"hx-fortress/data-runner/internal/job"
)

// selfSigned is a certificate for name that no public authority signed, like a database's own.
func selfSigned(t *testing.T, name string) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: name},
		DNSNames:     []string{name},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// server accepts TLS connections and answers each with one byte.
func server(t *testing.T, cert tls.Certificate) string {
	t.Helper()
	l, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_ = c.(*tls.Conn).Handshake()
				_, _ = c.Write([]byte{1})
			}()
		}
	}()
	return l.Addr().String()
}

func jobWith(mode, min string) job.Job {
	return job.Job{Server: job.HostPort{Host: "db.example.internal", Port: 5432}, TLS: job.TLS{Mode: mode, MinVersion: min}}
}

func handshake(t *testing.T, addr string, cfg *tls.Config) error {
	t.Helper()
	raw, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	conn := tls.Client(raw, cfg)
	defer conn.Close()
	return conn.Handshake()
}

func TestRequireEncryptsAndSaysTheCertificateWasNotChecked(t *testing.T) {
	addr := server(t, selfSigned(t, "db.example.internal"))
	capture := &Capture{}
	cfg, err := Config(jobWith("require", "1.2"), capture)
	if err != nil {
		t.Fatal(err)
	}
	if err := handshake(t, addr, cfg); err != nil {
		t.Fatalf("require refused a self-signed server: %v", err)
	}
	enc := capture.Encryption()
	if enc.Kind != "tls" || enc.Verified || enc.Version == nil || !strings.HasPrefix(*enc.Version, "TLS 1.") || enc.Cipher == nil {
		t.Fatalf("capture says %+v", enc)
	}
}

func TestVerifyRefusesACertificateNoAuthoritySigned(t *testing.T) {
	addr := server(t, selfSigned(t, "db.example.internal"))
	capture := &Capture{}
	cfg, err := Config(jobWith("verify", "1.2"), capture)
	if err != nil {
		t.Fatal(err)
	}
	err = handshake(t, addr, cfg)
	if err == nil || !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("verify accepted a self-signed certificate: %v", err)
	}
	if capture.State() != nil {
		t.Fatal("a refused handshake was recorded")
	}
}

func TestVerifyChecksTheServersOwnNameNotTheTunnelsAddress(t *testing.T) {
	j := jobWith("verify", "1.2")
	cfg, _ := Config(j, &Capture{})
	if cfg.ServerName != "db.example.internal" {
		t.Fatalf("server name %q", cfg.ServerName)
	}
	j.TLS.ServerName = "db.example.com"
	cfg, _ = Config(j, &Capture{})
	if cfg.ServerName != "db.example.com" {
		t.Fatalf("the job's own server name was not used: %q", cfg.ServerName)
	}
}

func TestOffHasNoConfigAndOldServersGetOldSuites(t *testing.T) {
	if cfg, err := Config(jobWith("off", "1.2"), &Capture{}); cfg != nil || err != nil {
		t.Fatalf("off gave %v, %v", cfg, err)
	}
	cfg, _ := Config(jobWith("require", "1.0"), &Capture{})
	if cfg.MinVersion != tls.VersionTLS10 || len(cfg.CipherSuites) <= len(tls.CipherSuites()) {
		t.Fatalf("an old server's settings: min %x, %d suites", cfg.MinVersion, len(cfg.CipherSuites))
	}
	modern, _ := Config(jobWith("verify", "1.2"), &Capture{})
	if modern.CipherSuites != nil {
		t.Fatal("a modern server's settings name suites of their own")
	}
	if c := (&Capture{}).Encryption(); c.Kind != "none" {
		t.Fatalf("no handshake reads as %+v", c)
	}
}

// signedBy is a certificate for name signed by a test authority, and that authority's pool.
func signedBy(t *testing.T, name string) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "test authority"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, _ := x509.ParseCertificate(caDER)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(3), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, pool
}

// A driver may set the config's ServerName to the host it dials (go-ora does). The certificate is
// still checked against the job's own name, and a certificate valid only for the dialed host is
// still refused.
func TestVerifyChecksTheJobsNameWhateverServerNameADriverSets(t *testing.T) {
	j := jobWith("verify", "1.2")
	j.TLS.ServerName = "db.corp.example"

	cert, pool := signedBy(t, "db.corp.example")
	capture := &Capture{}
	cfg, err := Config(j, capture)
	if err != nil {
		t.Fatal(err)
	}
	cfg.RootCAs = pool
	cfg.ServerName = "db-internal.lan"
	if err := handshake(t, server(t, cert), cfg); err != nil {
		t.Fatalf("a certificate for the job's name was refused: %v", err)
	}
	if e := capture.Encryption(); e.Kind != "tls" || !e.Verified {
		t.Fatalf("capture = %+v", e)
	}

	other, otherPool := signedBy(t, "db-internal.lan")
	cfg2, err := Config(j, &Capture{})
	if err != nil {
		t.Fatal(err)
	}
	cfg2.RootCAs = otherPool
	cfg2.ServerName = "db-internal.lan"
	err = handshake(t, server(t, other), cfg2)
	if err == nil || !strings.Contains(err.Error(), "db.corp.example") {
		t.Fatalf("a certificate for the dialed host only was accepted, or refused for another reason: %v", err)
	}
}

// ─── a connection's own authority, and Cloud SQL ─────────────────────────

// testCA is a certificate authority a test makes: its certificate, its key and its PEM.
type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  string
}

func authority(t *testing.T, commonName string) testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: commonName, Organization: []string{"Example Test"}},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return testCA{cert: cert, key: key, pem: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))}
}

// issue is a server certificate the authority signs: a common name, DNS names (none for a Cloud SQL
// instance's), and the last moment it is valid.
func (ca testCA) issue(t *testing.T, commonName string, dnsNames []string, notAfter time.Time) tls.Certificate {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: commonName, Organization: []string{"Example Test"}}, DNSNames: dnsNames,
		NotBefore: time.Now().Add(-48 * time.Hour), NotAfter: notAfter,
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// issueLikeCloudSQL is a server certificate shaped like the one a Cloud SQL instance presents:
// its instance as the common name, its sql.goog DNS name, valid for ten years, and no extended
// key usage. Apple's verifier refuses such a certificate as "not standards compliant" even when
// its authority is trusted.
func (ca testCA) issueLikeCloudSQL(t *testing.T, commonName, dnsName string) tls.Certificate {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: commonName, Organization: []string{"Google, Inc"}, Country: []string{"US"}},
		DNSNames: []string{dnsName}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(10, 0, 0),
		KeyUsage: x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

const instance = "northstar-data-1:permits-main"

// cloudSQLJob is a MySQL job to a Cloud SQL instance's public address.
func cloudSQLJob(serverName, caPEM string) job.Job {
	return job.Job{
		Engine: "mysql",
		Server: job.HostPort{Host: "203.0.113.9", Port: 3306},
		TLS:    job.TLS{Mode: "verify", MinVersion: "1.2", ServerName: serverName, CACertificate: caPEM},
	}
}

// refusedWith shakes hands with a server and is the refusal the capture kept.
func refusedWith(t *testing.T, j job.Job, cert tls.Certificate) string {
	t.Helper()
	capture := &Capture{}
	cfg, err := Config(j, capture)
	if err != nil {
		t.Fatal(err)
	}
	err = handshake(t, server(t, cert), cfg)
	if err == nil {
		t.Fatal("the handshake passed")
	}
	refusal, ok := Refused(errors.New("TLS Handshake failed: "+err.Error()), capture)
	if !ok {
		t.Fatalf("no refusal kept for %v", err)
	}
	if capture.State() != nil {
		t.Fatal("a refused handshake was recorded")
	}
	return refusal.Words
}

func TestACloudSQLInstanceIsCheckedAgainstItsCommonNameWithItsOwnAuthority(t *testing.T) {
	ca := authority(t, "Test Cloud SQL Server CA")
	capture := &Capture{}
	cfg, err := Config(cloudSQLJob(instance, ca.pem), capture)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerName != "203.0.113.9" {
		t.Fatalf("an instance is no host name: the handshake names the host it dials, not %q", cfg.ServerName)
	}
	if err := handshake(t, server(t, ca.issue(t, instance, nil, time.Now().Add(time.Hour))), cfg); err != nil {
		t.Fatalf("the instance's own certificate was refused: %v", err)
	}
	if e := capture.Encryption(); e.Kind != "tls" || !e.Verified {
		t.Fatalf("capture = %+v", e)
	}
}

func TestAnotherCloudSQLInstanceIsRefusedNamingBoth(t *testing.T) {
	ca := authority(t, "Test Cloud SQL Server CA")
	words := refusedWith(t, cloudSQLJob(instance, ca.pem), ca.issue(t, "northstar-data-1:another-instance", nil, time.Now().Add(time.Hour)))
	want := "The server's certificate names the Cloud SQL instance northstar-data-1:another-instance, but this connection expects the Cloud SQL instance northstar-data-1:permits-main."
	if words != want {
		t.Fatalf("words:\n%s\nwant:\n%s", words, want)
	}
}

func TestACloudSQLCertificateCheckedAsAnAddressSaysWhatToPutWhere(t *testing.T) {
	ca := authority(t, "Test Cloud SQL Server CA")
	words := refusedWith(t, cloudSQLJob("", ""), ca.issue(t, instance, nil, time.Now().Add(time.Hour)))
	want := `The server's certificate names the Cloud SQL instance northstar-data-1:permits-main, but this connection expects 203.0.113.9. ` +
		`It is signed by "Test Cloud SQL Server CA", an authority this connection does not trust. ` +
		`To check it, put northstar-data-1:permits-main in Certificate Name and put that authority's certificate, the instance's server-ca.pem, in Certificate Authority.`
	if words != want {
		t.Fatalf("words:\n%s\nwant:\n%s", words, want)
	}
}

// With no authority of its own, a connection's chain is checked by the platform's verifier where
// there is one. On a Mac, Apple's refuses a certificate shaped like Cloud SQL's as "not standards
// compliant", not "unknown authority"; the words are still what Linux, where a deployed job runs,
// says: what to put in Certificate Name, and the instance's server-ca.pem in Certificate Authority.
func TestACertificateShapedLikeCloudSQLsGetsTheSameWordsOnEveryPlatform(t *testing.T) {
	ca := authority(t, "Test Cloud SQL Server CA")
	words := refusedWith(t, cloudSQLJob("", ""), ca.issueLikeCloudSQL(t, instance, "1-test.us-central1.sql.goog"))
	want := `The server's certificate names the Cloud SQL instance northstar-data-1:permits-main and 1-test.us-central1.sql.goog, but this connection expects 203.0.113.9. ` +
		`It is signed by "Test Cloud SQL Server CA", an authority this connection does not trust. ` +
		`To check it, put northstar-data-1:permits-main in Certificate Name and put that authority's certificate, the instance's server-ca.pem, in Certificate Authority.`
	if words != want {
		t.Fatalf("words:\n%s\nwant:\n%s", words, want)
	}
}

// The platform's own refusal of an instance's certificate, for a connection with no authority, is
// worded as an untrusted authority's, after the certificate's dates, which Go's own verifier checks
// first. Any other certificate, or a connection with an authority of its own, keeps the platform's
// words.
func TestAPlatformRefusalOfAnInstancesCertificateNamesItsAuthority(t *testing.T) {
	ca := authority(t, "Test Cloud SQL Server CA")
	leafOf := func(c tls.Certificate) []*x509.Certificate {
		leaf, err := x509.ParseCertificate(c.Certificate[0])
		if err != nil {
			t.Fatal(err)
		}
		return []*x509.Certificate{leaf}
	}
	platform := func(name string) error {
		return errors.New(`x509: “` + name + `” certificate is not standards compliant`)
	}
	now := time.Now()

	sentence, fix := chainWords(platform(instance), leafOf(ca.issueLikeCloudSQL(t, instance, "1-test.us-central1.sql.goog")), nil, now)
	if want := `is signed by "Test Cloud SQL Server CA", an authority this connection does not trust.`; sentence != want {
		t.Fatalf("instance: %q, want %q", sentence, want)
	}
	if want := "put that authority's certificate, the instance's server-ca.pem, in Certificate Authority"; fix != want {
		t.Fatalf("instance fix: %q, want %q", fix, want)
	}

	until := now.Add(-24 * time.Hour)
	sentence, fix = chainWords(platform(instance), leafOf(ca.issue(t, instance, nil, until)), nil, now)
	if want := "has expired: it was valid until " + until.UTC().Format("2006-01-02") + "."; sentence != want || fix != "" {
		t.Fatalf("expired instance: %q / %q, want %q", sentence, fix, want)
	}

	sentence, fix = chainWords(platform("db.county.example"), leafOf(ca.issue(t, "db.county.example", []string{"db.county.example"}, now.Add(time.Hour))), nil, now)
	if want := "was not accepted: “db.county.example” certificate is not standards compliant."; sentence != want || fix != "" {
		t.Fatalf("another server: %q / %q, want %q", sentence, fix, want)
	}

	sentence, _ = chainWords(platform(instance), leafOf(ca.issueLikeCloudSQL(t, instance, "1-test.us-central1.sql.goog")), []*x509.Certificate{ca.cert}, now)
	if want := "was not accepted: “northstar-data-1:permits-main” certificate is not standards compliant."; sentence != want {
		t.Fatalf("with an authority: %q, want %q", sentence, want)
	}
}

func TestTheConnectionsAuthorityTakesThePlaceOfTheSystems(t *testing.T) {
	ca := authority(t, "Test Cloud SQL Server CA")
	other := authority(t, "County Root CA")
	words := refusedWith(t, cloudSQLJob(instance, other.pem), ca.issue(t, instance, nil, time.Now().Add(time.Hour)))
	want := `The server's certificate is signed by "Test Cloud SQL Server CA", and this connection trusts only "County Root CA". ` +
		`To check it, put the instance's server-ca.pem, as Cloud SQL gives it now, in Certificate Authority.`
	if words != want {
		t.Fatalf("words:\n%s\nwant:\n%s", words, want)
	}
	// A server whose certificate a public authority signed, with a connection that names its own:
	// only the connection's authority counts.
	j := jobWith("verify", "1.2")
	j.TLS.CACertificate = other.pem
	cert, _ := signedBy(t, "db.example.internal")
	if words := refusedWith(t, j, cert); words != `The server's certificate is signed by "test authority", and this connection trusts only "County Root CA".` {
		t.Fatalf("words: %s", words)
	}
}

// While a Cloud SQL instance's server CA is replaced, its server-ca.pem holds both CAs: a server
// certificate from either passes.
func TestAServerCAFileWithTwoAuthoritiesTrustsBoth(t *testing.T) {
	old, next := authority(t, "Test Cloud SQL Server CA 1"), authority(t, "Test Cloud SQL Server CA 2")
	both := old.pem + next.pem
	for _, ca := range []testCA{old, next} {
		capture := &Capture{}
		cfg, err := Config(cloudSQLJob(instance, both), capture)
		if err != nil {
			t.Fatal(err)
		}
		if err := handshake(t, server(t, ca.issue(t, instance, nil, time.Now().Add(time.Hour))), cfg); err != nil {
			t.Fatalf("%s: %v", ca.cert.Subject.CommonName, err)
		}
	}
}

func TestADNSNameIsCheckedAgainstTheCertificatesNamesAndSaysThem(t *testing.T) {
	ca := authority(t, "County Root CA")
	j := jobWith("verify", "1.2")
	j.TLS.ServerName = "sql-02.county.example"
	j.TLS.CACertificate = ca.pem
	words := refusedWith(t, j, ca.issue(t, "sql-01", []string{"sql-01.county.example", "sql-01"}, time.Now().Add(time.Hour)))
	if want := "The server's certificate names sql-01.county.example and sql-01, but this connection expects sql-02.county.example."; words != want {
		t.Fatalf("words:\n%s\nwant:\n%s", words, want)
	}
	words = refusedWith(t, j, ca.issue(t, "sql-02.county.example", nil, time.Now().Add(time.Hour)))
	if want := `The server's certificate names no server: its common name, "sql-02.county.example", is not a name a certificate is checked against. This connection expects sql-02.county.example.`; words != want {
		t.Fatalf("words:\n%s\nwant:\n%s", words, want)
	}
}

func TestAnExpiredCertificateSaysWhen(t *testing.T) {
	ca := authority(t, "Test Cloud SQL Server CA")
	until := time.Now().Add(-24 * time.Hour)
	words := refusedWith(t, cloudSQLJob(instance, ca.pem), ca.issue(t, instance, nil, until))
	if want := "The server's certificate has expired: it was valid until " + until.UTC().Format("2006-01-02") + "."; words != want {
		t.Fatalf("words:\n%s\nwant:\n%s", words, want)
	}
}

func TestAnAuthorityThatIsNoCertificateIsRefusedBeforeAnyHandshake(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalECPrivateKey(key)
	cases := map[string]string{
		string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})): "The connection's certificate authority holds a private key, where only certificates belong.",
		"server-ca.pem": "The connection's certificate authority holds no certificate.",
		string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der[:20]})): "Certificate 1 of the connection's certificate authority could not be read: ",
	}
	for text, want := range cases {
		_, err := Config(cloudSQLJob(instance, text), &Capture{})
		refusal, ok := Refused(err, nil)
		if !ok || !strings.HasPrefix(refusal.Words, want) {
			t.Fatalf("%q: %v", want, err)
		}
	}
	// `require` checks nothing, so it reads no authority.
	j := cloudSQLJob(instance, "server-ca.pem")
	j.TLS.Mode = "require"
	if _, err := Config(j, &Capture{}); err != nil {
		t.Fatalf("require read the authority: %v", err)
	}
}

func TestCloudSQLInstanceNamesAgreeWithTheTypeScriptSide(t *testing.T) {
	data, err := os.ReadFile("../../contract/vectors/certificate-names.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Instances []string `json:"instances"`
		Others    []string `json:"others"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Instances) == 0 || len(vectors.Others) == 0 {
		t.Fatal("no vectors")
	}
	for _, name := range vectors.Instances {
		if !IsCloudSQLInstance(name) {
			t.Errorf("%q is a Cloud SQL instance", name)
		}
	}
	for _, name := range vectors.Others {
		if IsCloudSQLInstance(name) {
			t.Errorf("%q is no Cloud SQL instance", name)
		}
	}
}
