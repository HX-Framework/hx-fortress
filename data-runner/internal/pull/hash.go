package pull

import "fmt"

// A value's start, and a missing value, outside the range of a UTF-16 code unit.
const (
	hashValue   = 0x1_0001
	hashMissing = 0x1_0002
)

// RowHash64 is a 64-bit hash of a row's values. It is the store's own `rowHash`, in Go: it reads
// each value's UTF-16 code units, so a row hashes the same here and in the store
// (contract/vectors/row-hash.json holds the vectors both sides check). The values'
// order counts, and a NULL differs from an empty value. It finds changes; it does not guard against
// anyone forging a collision. No value is copied: a table of millions of rows hashes every row, also
// the ones that never leave.
func RowHash64(values []*string) uint64 {
	h1 := uint32(0xdeadbeef) ^ uint32(len(values))
	h2 := uint32(0x41c6ce57) ^ uint32(len(values))
	for _, v := range values {
		if v == nil {
			h1 = (h1 ^ hashMissing) * 2654435761
			h2 = (h2 ^ hashMissing) * 1597334677
			continue
		}
		h1 = (h1 ^ hashValue) * 2654435761
		h2 = (h2 ^ hashValue) * 1597334677
		units := uint32(0)
		for _, r := range *v {
			if r >= 0x10000 {
				// Two code units, as a string in the store holds it.
				r -= 0x10000
				hi, lo := uint32(0xd800+(r>>10)), uint32(0xdc00+(r&0x3ff))
				h1 = ((h1^hi)*2654435761 ^ lo) * 2654435761
				h2 = ((h2^hi)*1597334677 ^ lo) * 1597334677
				units += 2
				continue
			}
			h1 = (h1 ^ uint32(r)) * 2654435761
			h2 = (h2 ^ uint32(r)) * 1597334677
			units++
		}
		h1 = (h1 ^ units) * 2654435761
		h2 = (h2 ^ units) * 1597334677
	}
	h1 = (h1 ^ (h1 >> 16)) * 2246822507
	h1 ^= (h2 ^ (h2 >> 13)) * 3266489909
	h2 = (h2 ^ (h2 >> 16)) * 2246822507
	h2 ^= (h1 ^ (h1 >> 13)) * 3266489909
	return uint64(h2)<<32 | uint64(h1)
}

// HashText is a row's hash as the store keeps it: 16 hex digits.
func HashText(h uint64) string { return fmt.Sprintf("%016x", h) }

// RowHash is RowHash64 as 16 hex digits.
func RowHash(values []*string) string { return HashText(RowHash64(values)) }
