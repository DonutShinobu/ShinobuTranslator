groupshared float4 inp[4][18][18];

[numthreads(16, 16, 1)]
void main(uint local_invocation_index : SV_GroupIndex)
{
    for (uint i = local_invocation_index; i < 4 * 18 * 18; i += 16 * 16) {
        uint outer = i / (18 * 18);
        uint remainder = i % (18 * 18);
        uint middle = remainder / 18;
        uint inner = remainder % 18;
        inp[outer][middle][inner] = (float4)0;
    }
    GroupMemoryBarrierWithGroupSync();
    float4 phony = inp[0][0][0];
    return;
}
