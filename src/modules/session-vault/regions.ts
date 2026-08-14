// Curated location lists for the wizard's region dropdown. Not exhaustive — the
// common choices, plus the wizard accepts a typed value for anything else.

export interface RegionChoice {
  value: string;
  label: string;
}

export const GCS_LOCATIONS: RegionChoice[] = [
  { value: "us-central1", label: "us-central1 (Iowa)" },
  { value: "us-east1", label: "us-east1 (South Carolina)" },
  { value: "us-east4", label: "us-east4 (N. Virginia)" },
  { value: "us-west1", label: "us-west1 (Oregon)" },
  { value: "europe-west1", label: "europe-west1 (Belgium)" },
  { value: "europe-west2", label: "europe-west2 (London)" },
  { value: "europe-west3", label: "europe-west3 (Frankfurt)" },
  { value: "asia-south1", label: "asia-south1 (Mumbai)" },
  { value: "asia-southeast1", label: "asia-southeast1 (Singapore)" },
  { value: "asia-northeast1", label: "asia-northeast1 (Tokyo)" },
  { value: "australia-southeast1", label: "australia-southeast1 (Sydney)" },
  { value: "US", label: "US (multi-region)" },
  { value: "EU", label: "EU (multi-region)" },
];

export const AWS_REGIONS: RegionChoice[] = [
  { value: "us-east-1", label: "us-east-1 (N. Virginia)" },
  { value: "us-east-2", label: "us-east-2 (Ohio)" },
  { value: "us-west-2", label: "us-west-2 (Oregon)" },
  { value: "eu-west-1", label: "eu-west-1 (Ireland)" },
  { value: "eu-west-2", label: "eu-west-2 (London)" },
  { value: "eu-central-1", label: "eu-central-1 (Frankfurt)" },
  { value: "ap-south-1", label: "ap-south-1 (Mumbai)" },
  { value: "ap-southeast-1", label: "ap-southeast-1 (Singapore)" },
  { value: "ap-northeast-1", label: "ap-northeast-1 (Tokyo)" },
  { value: "ap-southeast-2", label: "ap-southeast-2 (Sydney)" },
];
