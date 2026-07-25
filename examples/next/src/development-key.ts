// Public example material: never use this private key outside local development.
export const developmentKey = {
  kid: "development-only",
  privateJwk: {
    kty: "EC",
    crv: "P-256",
    x: "8WS_Q47lhDqUR6RiqD_2j145Xdzj5EPh6m-Iv8wcJuk",
    y: "lI86kqVetO4fLOC_7yF_42CY5YlL_koHmpuA1d3gAbg",
    d: "Ini99ROS-Um_oq6Dpqq_XVjfSK_8NtaHcyXBEDmUYx4",
  },
  publicJwk: {
    kty: "EC",
    crv: "P-256",
    x: "8WS_Q47lhDqUR6RiqD_2j145Xdzj5EPh6m-Iv8wcJuk",
    y: "lI86kqVetO4fLOC_7yF_42CY5YlL_koHmpuA1d3gAbg",
  },
} as const;
