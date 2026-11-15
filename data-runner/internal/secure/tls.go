// Package secure builds the driver's TLS settings from a job, checks the server's certificate
// against the job's own name and authority, and records what the handshake actually negotiated, so
// a test reports the version, the cipher and whether the certificate was checked as the driver saw
// them, not as the job asked.
package secure

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"hx-fortress/data-runner/internal/job"
)

// Refusal is a certificate the job's settings refuse, or settings that cannot be read, in words for
// the person who set the connection up: what the certificate names and what the connection
// expects, who signed it and whom the connection trusts, and what to change.
type Refusal struct{ Words string }

func (r *Refusal) Error() string { return r.Words }

// Refused is the refusal behind err, else the one the capture recorded during a handshake: a driver
// may keep only a handshake error's text (go-mssqldb's TDS 7 login does), so a refusal is never
// lost to how a driver wraps it.
func Refused(err error, capture *Capture) (*Refusal, bool) {
	var r *Refusal
	if errors.As(err, &r) {
		return r, true
	}
	if capture != nil {
		if r := capture.Refusal(); r != nil {
			return r, true
		}
	}
	return nil, false
}

// Capture keeps the state of the last TLS handshake a driver completed with a config from Config,
// and the last certificate that config refused.
type Capture struct {
	mu       sync.Mutex
	state    *tls.ConnectionState
	verified bool
	refusal  *Refusal
}

// State is the last handshake's state, or nil when none completed.
func (c *Capture) State() *tls.ConnectionState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}

// Refusal is the last certificate refused, or nil.
func (c *Capture) Refusal() *Refusal {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.refusal
}

func (c *Capture) record(cs tls.ConnectionState, verified bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	state := cs
	c.state = &state
	c.verified = verified
}

func (c *Capture) refuse(r *Refusal) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refusal = r
}

// Encryption is what the capture saw, in the contract's words: `tls` with the version and cipher
// when a handshake completed, else `none`.
func (c *Capture) Encryption() job.Encryption {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == nil {
		return job.Encryption{Kind: "none"}
	}
	return job.Encryption{
		Kind:     "tls",
		Version:  job.Str(tls.VersionName(c.state.Version)),
		Cipher:   job.Str(tls.CipherSuiteName(c.state.CipherSuite)),
		Verified: c.verified,
	}
}

var minVersions = map[string]uint16{
	"1.0": tls.VersionTLS10,
	"1.1": tls.VersionTLS11,
	"1.2": tls.VersionTLS12,
	"1.3": tls.VersionTLS13,
}

// cloudSQLInstanceRE is a Cloud SQL instance as its server certificate names it: the project's id
// and the instance's, `project:instance`, with a domain-scoped project's domain in front
// (`example.com:project:instance`). The TypeScript side's CLOUD_SQL_INSTANCE_RE is the same, and
// both read contract/vectors/certificate-names.json.
var cloudSQLInstanceRE = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z](?:[a-z0-9-]*[a-z0-9])?$`)

// IsCloudSQLInstance says whether a certificate name is a Cloud SQL instance (`project:instance`),
// which its certificate carries as its common name, rather than a server's DNS name or address.
func IsCloudSQLInstance(name string) bool {
	return cloudSQLInstanceRE.MatchString(name)
}

// ServerName is the name a server's certificate must carry: the job's own, else the server's host
// as the connector sees it.
func ServerName(j job.Job) string {
	if j.TLS.ServerName != "" {
		return j.TLS.ServerName
	}
	return j.Server.Host
}

// Authorities reads a job's certificate authority: every certificate in its PEM, as a pool, and the
// certificates themselves, for the words of a refusal. No PEM is no pool: the system's authorities.
func Authorities(pemText string) (*x509.CertPool, []*x509.Certificate, error) {
	if strings.TrimSpace(pemText) == "" {
		return nil, nil, nil
	}
	pool := x509.NewCertPool()
	var certs []*x509.Certificate
	rest := []byte(pemText)
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			what := fmt.Sprintf("a block of the kind %q", block.Type)
			if strings.Contains(block.Type, "PRIVATE KEY") {
				what = "a private key"
			}
			return nil, nil, &Refusal{Words: fmt.Sprintf("The connection's certificate authority holds %s, where only certificates belong.", what)}
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, nil, &Refusal{Words: fmt.Sprintf("Certificate %d of the connection's certificate authority could not be read: %s.", len(certs)+1, strings.TrimPrefix(err.Error(), "x509: "))}
		}
		pool.AddCert(cert)
		certs = append(certs, cert)
	}
	if len(certs) == 0 {
		return nil, nil, &Refusal{Words: "The connection's certificate authority holds no certificate."}
	}
	return pool, certs, nil
}

// Config is the TLS config for a job's driver, or nil when the job's mode is `off`. Every
// handshake made with it lands in capture, and every certificate it refuses too.
//
// `verify` and `strict` check the certificate: its chain against the job's own authority, else the
// system's, and its name against ServerName. A Cloud SQL instance is checked against the
// certificate's common name, the way Cloud SQL's own connectors check it, and the handshake names
// the host it dials, since an instance is no host name. `require` encrypts without checking (a
// server with a certificate it made itself). A minimum below 1.2 also allows the older cipher
// suites such servers speak, which Go leaves out by default.
//
// The check is VerifyConnection's own, against the job's name: a driver may set the config's
// ServerName to the host it dials (go-ora does), and the name a certificate must carry is the
// job's, never the driver's. The library's own check is off so that it cannot check another.
func Config(j job.Job, capture *Capture) (*tls.Config, error) {
	if j.TLS.Mode == "off" {
		return nil, nil
	}
	min, ok := minVersions[j.TLS.MinVersion]
	if !ok {
		return nil, fmt.Errorf("unknown TLS version %q", j.TLS.MinVersion)
	}
	verify := j.TLS.Mode != "require"
	var roots *x509.CertPool
	var authorities []*x509.Certificate
	if verify {
		var err error
		if roots, authorities, err = Authorities(j.TLS.CACertificate); err != nil {
			return nil, err
		}
	}
	name := ServerName(j)
	sni := name
	if IsCloudSQLInstance(name) {
		sni = j.Server.Host
	}
	var cfg *tls.Config
	cfg = &tls.Config{
		ServerName: sni,
		MinVersion: min,
		RootCAs:    roots,
		// The library checks nothing itself: VerifyConnection checks the chain and the job's name
		// for `verify` and `strict`. `require` skips the check on purpose: the admin chose it for a
		// server whose certificate no public authority signed. The handshake still encrypts.
		InsecureSkipVerify: true, //nolint:gosec // verified below against the job's own name, or chosen per connection as unverified
		VerifyConnection: func(cs tls.ConnectionState) error {
			if verify {
				if r := checkPeer(cs, name, cfg.RootCAs, authorities, time.Now()); r != nil {
					capture.refuse(r)
					return r
				}
			}
			capture.record(cs, verify)
			return nil
		},
	}
	if min < tls.VersionTLS12 {
		suites := []uint16{}
		for _, s := range tls.CipherSuites() {
			suites = append(suites, s.ID)
		}
		for _, s := range tls.InsecureCipherSuites() {
			suites = append(suites, s.ID)
		}
		cfg.CipherSuites = suites
	}
	return cfg, nil
}

// checkPeer checks the server's certificate: its chain against roots (the system's when nil), and
// its name against name. A refusal says what the certificate names and what the connection
// expects, who signed it when the connection does not trust them, and what to put where.
func checkPeer(cs tls.ConnectionState, name string, roots *x509.CertPool, authorities []*x509.Certificate, now time.Time) *Refusal {
	if len(cs.PeerCertificates) == 0 {
		return &Refusal{Words: "The server sent no certificate."}
	}
	leaf := cs.PeerCertificates[0]
	opts := x509.VerifyOptions{Roots: roots, Intermediates: x509.NewCertPool(), CurrentTime: now}
	for _, c := range cs.PeerCertificates[1:] {
		opts.Intermediates.AddCert(c)
	}
	_, chainErr := leaf.Verify(opts)
	instance := IsCloudSQLInstance(name)
	nameOK := leaf.Subject.CommonName == name
	if !instance {
		nameOK = leaf.VerifyHostname(name) == nil
	}
	if chainErr == nil && nameOK {
		return nil
	}

	// A fix is offered only where the connection named nothing yet: a name or an authority it does
	// name is never swapped for whatever this server presents, which may be the wrong server.
	var sentences, fixes []string
	cn := leaf.Subject.CommonName
	subject := "The server's certificate"
	if !nameOK {
		sentences = append(sentences, namedWords(leaf, name, instance))
		if IsCloudSQLInstance(cn) && !instance {
			fixes = append(fixes, "put "+cn+" in Certificate Name")
		}
		subject = "It"
	}
	if chainErr != nil {
		sentence, fix := chainWords(chainErr, cs.PeerCertificates, authorities, now)
		sentences = append(sentences, subject+" "+sentence)
		if fix != "" {
			fixes = append(fixes, fix)
		}
	}
	words := strings.Join(sentences, " ")
	if len(fixes) > 0 {
		words += " To check it, " + strings.Join(fixes, " and ") + "."
	}
	return &Refusal{Words: words}
}

// namedWords says what the certificate names and what the connection expects.
func namedWords(leaf *x509.Certificate, name string, instance bool) string {
	expected := name
	if instance {
		expected = "the Cloud SQL instance " + name
	}
	cn := leaf.Subject.CommonName
	var named []string
	if IsCloudSQLInstance(cn) {
		named = append(named, "the Cloud SQL instance "+cn)
	}
	named = append(named, leaf.DNSNames...)
	for _, ip := range leaf.IPAddresses {
		named = append(named, ip.String())
	}
	if len(named) == 0 && cn != "" {
		if instance {
			// The common name is what a Cloud SQL instance is checked against.
			named = append(named, `"`+cn+`"`)
		} else {
			return fmt.Sprintf(`The server's certificate names no server: its common name, "%s", is not a name a certificate is checked against. This connection expects %s.`, cn, expected)
		}
	}
	if len(named) == 0 {
		return fmt.Sprintf("The server's certificate names no server, but this connection expects %s.", expected)
	}
	return fmt.Sprintf("The server's certificate names %s, but this connection expects %s.", listWords(named, 5), expected)
}

// chainWords says why the certificate's chain was not accepted, after "The server's certificate"
// or "It", and what would let it pass. chain is what the server sent, its own certificate first.
func chainWords(err error, chain []*x509.Certificate, authorities []*x509.Certificate, now time.Time) (sentence, fix string) {
	leaf := chain[0]
	var unknown x509.UnknownAuthorityError
	if errors.As(err, &unknown) {
		return untrustedWords(chain, authorities)
	}
	var invalid x509.CertificateInvalidError
	if errors.As(err, &invalid) && invalid.Reason == x509.Expired && invalid.Cert != nil {
		return datesWords(invalid.Cert, leaf, now), ""
	}
	// With no authority of its own, a connection's chain is checked against the system's, and on
	// macOS Go hands that check to Apple's verifier. Apple refuses a Cloud SQL instance's certificate
	// (valid ten years, no server authentication in its key usage) as "not standards compliant",
	// even with its authority trusted, where Go's own verifier, which a deployed job runs on Linux,
	// answers "unknown authority". No system trusts an instance's own authority, so a runner on a Mac
	// says what a deployed one says: the certificate's dates first, as Go's verifier checks them
	// first, then who signed it and what to put where.
	if len(authorities) == 0 && IsCloudSQLInstance(leaf.Subject.CommonName) {
		if now.Before(leaf.NotBefore) || now.After(leaf.NotAfter) {
			return datesWords(leaf, leaf, now), ""
		}
		return untrustedWords(chain, authorities)
	}
	return "was not accepted: " + strings.TrimPrefix(err.Error(), "x509: ") + ".", ""
}

// untrustedWords says who signed a chain the connection does not trust, after "The server's
// certificate" or "It", and what would let it pass.
func untrustedWords(chain []*x509.Certificate, authorities []*x509.Certificate) (sentence, fix string) {
	leaf := chain[0]
	top := lastSent(chain)
	signer := nameOf(top.Issuer.CommonName, top.Issuer.String())
	if top == leaf && bytes.Equal(leaf.RawIssuer, leaf.RawSubject) {
		if len(authorities) == 0 {
			return fmt.Sprintf(`is signed by itself, "%s", and this connection does not trust it.`, signer), "put the server's own certificate in Certificate Authority"
		}
		return fmt.Sprintf(`is signed by itself, "%s", and this connection trusts only %s.`, signer, trustedWords(authorities)), ""
	}
	cloudSQL := IsCloudSQLInstance(leaf.Subject.CommonName)
	if len(authorities) == 0 {
		if cloudSQL {
			return fmt.Sprintf(`is signed by "%s", an authority this connection does not trust.`, signer), "put that authority's certificate, the instance's server-ca.pem, in Certificate Authority"
		}
		return fmt.Sprintf(`is signed by "%s", an authority this connection does not trust.`, signer), "put that authority's certificate in Certificate Authority"
	}
	if cloudSQL {
		// A Cloud SQL instance's server-ca.pem holds the CA that replaces the current one too,
		// so the file as the instance gives it now is the fix for a rotated CA.
		return fmt.Sprintf(`is signed by "%s", and this connection trusts only %s.`, signer, trustedWords(authorities)), "put the instance's server-ca.pem, as Cloud SQL gives it now, in Certificate Authority"
	}
	return fmt.Sprintf(`is signed by "%s", and this connection trusts only %s.`, signer, trustedWords(authorities)), ""
}

// datesWords says that cert, the server's own certificate (leaf) or one in its chain, is not valid
// at now: not yet, or no longer.
func datesWords(cert, leaf *x509.Certificate, now time.Time) string {
	whose := "it"
	if cert != leaf {
		whose = fmt.Sprintf(`the certificate of "%s" in its chain`, nameOf(cert.Subject.CommonName, cert.Subject.String()))
	}
	if now.Before(cert.NotBefore) {
		return fmt.Sprintf("is not valid yet: %s is valid from %s.", whose, cert.NotBefore.UTC().Format("2006-01-02"))
	}
	return fmt.Sprintf("has expired: %s was valid until %s.", whose, cert.NotAfter.UTC().Format("2006-01-02"))
}

// lastSent follows the certificates the server sent from its own up through their issuers, and is
// the last of them: its issuer is the authority the connection would need to trust.
func lastSent(chain []*x509.Certificate) *x509.Certificate {
	top := chain[0]
	for range chain {
		if bytes.Equal(top.RawIssuer, top.RawSubject) {
			return top
		}
		var next *x509.Certificate
		for _, c := range chain {
			if c != top && bytes.Equal(c.RawSubject, top.RawIssuer) {
				next = c
				break
			}
		}
		if next == nil {
			return top
		}
		top = next
	}
	return top
}

// trustedWords names the connection's own authorities: `"A"`, `"A" and "B"`.
func trustedWords(authorities []*x509.Certificate) string {
	names := make([]string, 0, len(authorities))
	for _, a := range authorities {
		names = append(names, `"`+nameOf(a.Subject.CommonName, a.Subject.String())+`"`)
	}
	return listWords(names, 5)
}

// nameOf is a certificate's common name, else its whole subject.
func nameOf(commonName, subject string) string {
	if commonName != "" {
		return commonName
	}
	return subject
}

// listWords is "a", "a and b", "a, b and c", with at most max named and the rest counted.
func listWords(items []string, max int) string {
	if len(items) > max {
		items = append(items[:max:max], fmt.Sprintf("%d more", len(items)-max))
	}
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	}
	return strings.Join(items[:len(items)-1], ", ") + " and " + items[len(items)-1]
}
