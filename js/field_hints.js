// GC-ATLAS — one-line hints and search synonyms for the field picker.
// Kept out of FIELDS (data.js) so the field table stays one line per field.
// hint: what the field is good for, shown in the picker footer.
// aka:  extra search terms (symbols, abbreviations, common names).

export const FIELD_HINTS = {
    // Dynamics
    t:      { hint: 'Thermal structure; its meridional gradient sets the jets through thermal wind.', aka: 'temperature T' },
    u:      { hint: 'Jets, trade easterlies, QBO; the zero line separates easterly and westerly regimes.', aka: 'zonal wind westerlies easterlies' },
    v:      { hint: 'Meridional flow: Hadley-cell branches, cross-equatorial monsoon flow.', aka: 'meridional wind' },
    wspd:   { hint: 'Jet cores: subtropical and eddy-driven jets (speed of the monthly-mean wind).', aka: 'jet stream speed |V| magnitude' },
    vo:     { hint: 'Troughs, ridges and shear zones; cyclonic is positive in the NH.', aka: 'zeta ζ vorticity' },
    d:      { hint: 'Upper-level outflow over convection, convergence aloft over subsidence.', aka: 'divergence convergence' },
    w:      { hint: 'Rising motion (ω < 0) in the ITCZ and monsoons, sinking over the subtropics.', aka: 'omega ω vertical velocity ascent subsidence' },
    z:      { hint: 'Planetary waves, troughs and ridges, the polar vortex; flow runs along the contours.', aka: 'geopotential height Z gph' },
    psi:    { hint: 'Rotational (non-divergent) flow: subtropical anticyclones, the Tibetan high.', aka: 'ψ streamfunction rotational' },
    chi:    { hint: 'Divergent flow: Walker and monsoon overturning, upper-level outflow centres.', aka: 'χ velocity potential divergent walker' },
    // Moisture
    q:      { hint: 'Water-vapour content: moist tropics and low-level moist tongues.', aka: 'specific humidity water vapour' },
    r:      { hint: 'Saturation: moist ITCZ, dry subsiding branches.', aka: 'RH relative humidity' },
    tcwv:   { hint: 'Column water vapour: the tropical moist belt and its seasonal migration.', aka: 'precipitable water PW PWAT TCWV' },
    tp:     { hint: 'ITCZ, monsoons and storm tracks.', aka: 'precipitation rain rainfall P' },
    // Derived & PV
    pv:     { hint: 'Dynamic tropopause (2 PVU) and stratospheric PV on isentropic surfaces.', aka: 'potential vorticity PVU Ertel tropopause isentropic' },
    mse:    { hint: 'Moist static energy; highest over the warmest, moistest boundary layers.', aka: 'MSE h moist static energy' },
    dls:    { hint: '200–850 hPa shear of the monthly-mean flow (TC-genesis context).', aka: 'deep layer shear VWS vertical wind shear' },
    // Surface
    t2m:    { hint: 'Near-surface climate: land–sea contrast, polar amplification.', aka: '2m temperature surface air temperature SAT T2m' },
    d2m:    { hint: 'Near-surface moisture as dewpoint.', aka: '2m dewpoint Td' },
    sst:    { hint: 'Ocean boundary forcing: warm pool, cold tongue, ENSO.', aka: 'SST sea surface temperature ocean' },
    msl:    { hint: 'Semi-permanent highs and lows: Aleutian and Icelandic lows, subtropical highs.', aka: 'MSLP SLP sea level pressure' },
    sp:     { hint: 'Surface pressure; terrain dominates, and it masks below-ground levels.', aka: 'surface pressure ps' },
    blh:    { hint: 'Mixed-layer depth: deep over hot deserts, shallow over cold oceans.', aka: 'PBL boundary layer height BLH' },
    // Surface fluxes
    ews:    { hint: 'Surface momentum exchange: trades versus westerlies, the angular-momentum source and sink.', aka: 'surface stress taux τ friction' },
    sshf:   { hint: 'Turbulent sensible-heat exchange: deserts, cold-air outbreaks over warm seas.', aka: 'sensible heat flux SH' },
    slhf:   { hint: 'Evaporation: subtropical oceans and western boundary currents.', aka: 'latent heat flux LH evaporation' },
    ssr:    { hint: 'Net shortwave absorbed at the surface.', aka: 'surface solar radiation SW' },
    str:    { hint: 'Net longwave at the surface.', aka: 'surface longwave radiation LW' },
    // TOA
    tisr:   { hint: 'Insolation: the seasonal driver.', aka: 'incoming solar insolation S' },
    tsr:    { hint: 'Absorbed solar radiation at the top of the atmosphere.', aka: 'ASR absorbed solar net shortwave' },
    olr:    { hint: 'Outgoing longwave: deep convection shows up as low OLR.', aka: 'OLR outgoing longwave' },
    netrad: { hint: 'TOA surplus and deficit that the circulation carries poleward.', aka: 'net radiation energy balance R_TOA' },
    albedo: { hint: 'Reflectivity: sea ice, snow, stratocumulus decks, deserts.', aka: 'planetary albedo reflectivity' },
    swcre:  { hint: 'Cloud cooling by reflection: stratocumulus decks, storm tracks.', aka: 'SW CRE cloud radiative effect cloud forcing' },
    lwcre:  { hint: 'Cloud greenhouse effect, largest for high, cold cloud tops.', aka: 'LW CRE cloud radiative effect cloud forcing' },
    netcre: { hint: 'Net radiative effect of clouds (SW + LW).', aka: 'CRE cloud radiative effect cloud forcing' },
    // Column energy transport
    vitoen: { hint: 'Poleward energy transport per unit length of latitude circle.', aka: 'energy transport MSE flux northward' },
    vitoee: { hint: 'Zonal energy flux per unit length.', aka: 'energy transport eastward' },
    vithen: { hint: 'Sensible-heat (c_pT) part of the energy flux.', aka: 'enthalpy dry static energy flux' },
    vign:   { hint: 'Geopotential (Φ) part of the energy flux.', aka: 'geopotential flux potential energy' },
    viken:  { hint: 'Kinetic-energy part of the energy flux.', aka: 'kinetic energy flux KE' },
    vitoed: { hint: 'Where the column exports (+) or imports (−) energy.', aka: 'energy flux divergence convergence' },
    // Column moisture & mass
    viwvn:  { hint: 'Poleward water-vapour transport.', aka: 'moisture transport vapour flux northward' },
    viwve:  { hint: 'Zonal water-vapour transport.', aka: 'moisture transport vapour flux eastward' },
    ivt:    { hint: 'Moisture-transport corridors (atmospheric-river regions in the time mean).', aka: 'IVT integrated vapour transport atmospheric river AR' },
    viman:  { hint: 'Meridional column mass flux.', aka: 'mass flux northward' },
    vimae:  { hint: 'Zonal column mass flux.', aka: 'mass flux eastward' },
    viwvd:  { hint: 'Moisture sources (E > P, +) and sinks (P > E, −).', aka: 'moisture flux divergence convergence E-P E−P' },
};
